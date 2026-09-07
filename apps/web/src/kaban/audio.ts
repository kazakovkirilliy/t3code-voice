import type { KabanSpeechBridge } from "@t3tools/contracts/kaban";

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return new Uint8Array(buffer);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export interface Recording {
  result: Promise<Uint8Array>;
  finish(): void;
  cancel(): void;
}

/** Capture starts only on a user gesture; the track is released on every exit. */
export async function startRecording(signal: AbortSignal, silenceMs = 700): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  if (signal.aborted) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("Recording cancelled");
  }
  let context: AudioContext | undefined;
  let recorder: MediaRecorder;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    recorder = new MediaRecorder(stream);
    context = new AudioContext();
    await context.resume();
    signal.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context?.close().catch(() => undefined);
    throw error;
  }
  const recordingContext = context;
  const levels = new Float32Array(analyser.fftSize);
  const chunks: Blob[] = [];
  let voicedMs = 0;
  let silentMs = 0;
  let elapsedMs = 0;
  let cancelled = false;
  let failed = false;
  let cleaned = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  const cancel = () => {
    cancelled = true;
    stop();
  };
  const result = new Promise<Uint8Array>((resolve, reject) => {
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(timer);
      signal.removeEventListener("abort", cancel);
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void recordingContext.close().catch(() => undefined);
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => {
      failed = true;
      cleanup();
      reject(new Error("Microphone recording failed"));
      stop();
    };
    recorder.onstop = () => {
      cleanup();
      if (failed) return;
      if (cancelled || signal.aborted) {
        reject(new Error("Recording cancelled"));
        return;
      }
      if (voicedMs < 180) {
        reject(new Error("No speech heard. Try speaking closer to the microphone."));
        return;
      }
      void (async () => {
        const bytes = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
        const decoder = new AudioContext();
        try {
          const decoded = await decoder.decodeAudioData(bytes);
          const duration = Math.min(decoded.duration, 60);
          const offline = new OfflineAudioContext(1, Math.ceil(duration * 16000), 16000);
          const node = offline.createBufferSource();
          node.buffer = decoded;
          node.connect(offline.destination);
          node.start();
          const rendered = await offline.startRendering();
          if (signal.aborted || cancelled) throw new Error("Recording cancelled");
          resolve(encodeWav(rendered.getChannelData(0), 16000));
        } finally {
          await decoder.close();
        }
      })().catch(reject);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      recorder.start(100);
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(levels);
      const rms = Math.sqrt(levels.reduce((sum, value) => sum + value * value, 0) / levels.length);
      elapsedMs += 50;
      if (rms > 0.012) {
        voicedMs += 50;
        silentMs = 0;
      } else if (voicedMs) silentMs += 50;
      if (
        (voicedMs >= 180 && silentMs >= silenceMs) ||
        elapsedMs >= 60_000 ||
        (!voicedMs && elapsedMs >= 10_000)
      )
        stop();
    }, 50);
  });
  return { result, finish: stop, cancel };
}

export async function transcribe(
  bridge: KabanSpeechBridge,
  wav: Uint8Array,
  port: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  const cancel = () => {
    void bridge.cancel(requestId).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await bridge.transcribe({
      requestId,
      port,
      language: "ru",
      wavBase64: base64(wav),
    });
    signal.throwIfAborted();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export class SpeechQueue {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private finishPlayback: (() => void) | null = null;
  private queued = 0;
  onError: (error: string) => void;
  onBusy: (busy: boolean) => void;
  constructor(onError: (error: string) => void, onBusy: (busy: boolean) => void) {
    this.onError = onError;
    this.onBusy = onBusy;
  }
  say(text: string, options: { engine: "system" | "piper"; port: number; voice: string }): void {
    if (!text.trim()) return;
    const generation = this.generation;
    // Bound queued audio when the model produces a long report.
    if (this.queued >= 24) {
      this.onError("Speech queue is full; the complete answer is available in the thread.");
      return;
    }
    this.queued++;
    // Split oversized reports without truncating the written answer.
    const pieces = text.match(/[\s\S]{1,1800}(?:\s|$)|[\s\S]{1,1800}/g) ?? [text];
    this.tail = this.tail
      .then(async () => {
        if (generation !== this.generation) return;
        this.onBusy(true);
        for (const piece of pieces) {
          if (generation !== this.generation) return;
          if (options.engine === "piper") await this.piper(piece, options.port, generation);
          else await this.system(piece, options.voice);
        }
      })
      .catch((error) => {
        if (generation === this.generation)
          this.onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.queued--;
        if (!this.queued) this.onBusy(false);
      });
  }
  stop(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.audio?.pause();
    this.audio = null;
    window.speechSynthesis?.cancel();
    this.finishPlayback?.();
    this.finishPlayback = null;
    this.onBusy(false);
  }
  private system(text: string, voiceName: string): Promise<void> {
    const synthesis = window.speechSynthesis;
    if (!synthesis) return Promise.reject(new Error("System speech unavailable. Select Piper."));
    const voices = synthesis.getVoices().filter((voice) => voice.localService);
    const voice =
      voices.find((item) => item.name === voiceName) ??
      voices.find((item) => item.lang.startsWith("ru"));
    if (!voice)
      return Promise.reject(
        new Error("Install a Russian system voice or select Piper in Kaban settings."),
      );
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      const finish = () => {
        clearTimeout(timer);
        this.finishPlayback = null;
        resolve();
      };
      const timer = setTimeout(() => {
        synthesis.cancel();
        finish();
      }, 120_000);
      this.finishPlayback = finish;
      utterance.onend = finish;
      utterance.onerror = (event) => {
        finish();
        if (event.error !== "canceled" && event.error !== "interrupted")
          this.onError(`System speech: ${event.error}`);
      };
      try {
        synthesis.speak(utterance);
      } catch (error) {
        clearTimeout(timer);
        this.finishPlayback = null;
        reject(error);
      }
    });
  }
  private async piper(text: string, port: number, generation: number): Promise<void> {
    const bridge = window.desktopBridge?.kabanSpeech;
    if (!bridge)
      throw new Error("Piper requires the Kaban desktop build on the microphone's computer.");
    const controller = (this.abort = new AbortController());
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void bridge.cancel(requestId).catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await bridge.synthesize({ requestId, port, text });
      if (generation !== this.generation) return;
      if (!result.ok) throw new Error(result.error);
      const bytes = Uint8Array.from(atob(result.value), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      try {
        await new Promise<void>((resolve, reject) => {
          const audio = (this.audio = new Audio(url));
          const cleanup = () => {
            clearTimeout(timer);
            audio.onended = null;
            audio.onerror = null;
            this.finishPlayback = null;
          };
          const finish = () => {
            cleanup();
            resolve();
          };
          const fail = (error: unknown) => {
            cleanup();
            audio.pause();
            reject(error);
          };
          const timer = setTimeout(() => fail(new Error("Audio playback timed out")), 120_000);
          this.finishPlayback = finish;
          audio.onended = finish;
          audio.onerror = () => fail(new Error("Audio playback failed"));
          void audio.play().catch(fail);
        });
      } finally {
        URL.revokeObjectURL(url);
        this.audio = null;
        this.finishPlayback = null;
      }
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      this.abort = null;
    }
  }
}
