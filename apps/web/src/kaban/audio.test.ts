import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { KabanSpeechBridge, KabanSpeechResult } from "@t3tools/contracts/kaban";
import { SpeechQueue, encodeWav, startRecording, transcribe } from "./audio";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("voice capture lifecycle", () => {
  it("encodes bounded mono PCM at Whisper's sample rate", () => {
    const bytes = encodeWav(new Float32Array([-2, 0, 2]), 16000);
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([
      -32768, 0, 32767,
    ]);
  });
  it("releases a microphone granted after cancellation", async () => {
    const permission = deferred<MediaStream>();
    const stop = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permission.promise } });
    const controller = new AbortController();
    const capture = startRecording(controller.signal);
    const rejected = expect(capture).rejects.toThrow(/cancelled/);
    controller.abort();
    permission.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
  });
  it("releases the track when the recorder cannot initialize", async () => {
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
    });
    vi.stubGlobal("MediaRecorder", function UnsupportedRecorder() {
      throw new Error("unsupported");
    });
    await expect(startRecording(new AbortController().signal)).rejects.toThrow("unsupported");
    expect(stop).toHaveBeenCalledOnce();
  });
  it("aborts active recording and clears its microphone and silence timer", async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    const close = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) },
    });
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          this.onstop?.();
        }
      },
    );
    vi.stubGlobal(
      "AudioContext",
      class {
        close = close;
        async resume() {}
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} };
        }
        createAnalyser() {
          return { fftSize: 1024, getFloatTimeDomainData() {} };
        }
      },
    );
    const controller = new AbortController();
    const recording = await startRecording(controller.signal);
    const rejected = expect(recording.result).rejects.toThrow(/cancelled/);
    controller.abort();
    await rejected;
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("discards late transcription results and cancels the desktop request", async () => {
    const response = deferred<KabanSpeechResult>();
    const cancel = vi.fn(async () => undefined);
    const bridge: KabanSpeechBridge = {
      transcribe: () => response.promise,
      synthesize: async () => ({ ok: true, value: "" }),
      cancel,
    };
    const controller = new AbortController();
    const transcript = transcribe(
      bridge,
      encodeWav(new Float32Array(1), 16000),
      8080,
      controller.signal,
    );
    const rejected = expect(transcript).rejects.toThrow();
    controller.abort();
    response.resolve({ ok: true, value: "Do not send this task" });
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("speech playback lifecycle", () => {
  it("stop discards late synthesis and all already queued sentences", async () => {
    const response = deferred<KabanSpeechResult>();
    const started = deferred<void>();
    const idle = deferred<void>();
    const synthesize = vi.fn(() => {
      started.resolve();
      return response.promise;
    });
    const cancel = vi.fn(async () => undefined);
    const audio = vi.fn();
    vi.stubGlobal("Audio", audio);
    vi.stubGlobal("window", { desktopBridge: { kabanSpeech: { synthesize, cancel } } });
    const errors = vi.fn();
    let stopped = false;
    const queue = new SpeechQueue(errors, (busy) => {
      if (!busy && stopped) idle.resolve();
    });
    const options = { engine: "piper" as const, port: 5000, voice: "" };
    queue.say("First sentence.", options);
    queue.say("Queued sentence.", options);
    await started.promise;
    queue.stop();
    stopped = true;
    response.resolve({ ok: true, value: "late audio" });
    await idle.promise;
    expect(cancel).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledOnce();
    expect(audio).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
  it("does not substitute a remote system voice for missing local voices", async () => {
    const idle = deferred<void>();
    const speak = vi.fn();
    vi.stubGlobal("window", {
      speechSynthesis: { getVoices: () => [{ localService: false, lang: "ru-RU" }], speak },
    });
    const error = vi.fn();
    const queue = new SpeechQueue(error, (busy) => {
      if (!busy) idle.resolve();
    });
    queue.say("Привет", { engine: "system", port: 5000, voice: "" });
    await idle.promise;
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Install a Russian system voice"));
    expect(speak).not.toHaveBeenCalled();
  });
});
