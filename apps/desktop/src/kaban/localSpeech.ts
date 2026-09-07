import type {
  KabanSpeechResult,
  KabanSynthesizeInput,
  KabanTranscribeInput,
} from "@t3tools/contracts/kaban";
import * as Schema from "effect/Schema";

const decodeTranscript = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

/** Speech stays on the microphone's machine, including when T3 controls a remote environment. */
export function createLocalSpeechTransport(request: typeof fetch = fetch) {
  const pending = new Map<string, AbortController>();

  async function run(
    requestId: string,
    engine: "Whisper" | "Piper",
    port: number,
    work: (signal: AbortSignal) => Promise<string>,
  ): Promise<KabanSpeechResult> {
    if (pending.has(requestId)) return { ok: false, error: "Speech request already exists." };
    if (pending.size >= 4)
      return { ok: false, error: "Too many speech requests. Cancel and retry." };
    const controller = new AbortController();
    pending.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const value = await work(controller.signal);
      controller.signal.throwIfAborted();
      return { ok: true, value };
    } catch (cause) {
      return {
        ok: false,
        error: controller.signal.aborted
          ? `${engine} request cancelled or timed out (127.0.0.1:${port}).`
          : cause instanceof TypeError && cause.message === "fetch failed"
            ? `Cannot connect to ${engine} at http://127.0.0.1:${port}. Start ${engine === "Whisper" ? "whisper-server" : "the Piper HTTP server"} on this computer and check the port in Kaban settings. T3 does not start speech servers automatically.`
            : `${engine} at http://127.0.0.1:${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  }

  async function readLimited(response: Response, max: number): Promise<Uint8Array> {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("Empty speech response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) throw new Error("Speech response exceeded its size limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }

  return {
    transcribe: (input: KabanTranscribeInput) =>
      run(input.requestId, "Whisper", input.port, async (signal) => {
        const wav = Buffer.from(input.wavBase64, "base64");
        if (
          wav.length < 44 ||
          wav.toString("ascii", 0, 4) !== "RIFF" ||
          wav.toString("ascii", 8, 12) !== "WAVE"
        ) {
          throw new Error("Expected a WAV recording");
        }
        const body = new FormData();
        body.set("file", new Blob([wav], { type: "audio/wav" }), "voice.wav");
        body.set("language", input.language);
        body.set("response_format", "json");
        body.set("temperature", "0.0");
        const response = await request(`http://127.0.0.1:${input.port}/inference`, {
          method: "POST",
          body,
          signal,
          redirect: "error",
        });
        const bytes = await readLimited(response, 256_000);
        const result = decodeTranscript(new TextDecoder().decode(bytes));
        if (!result.text.trim()) throw new Error("No speech recognized. Try again.");
        return result.text.trim();
      }),
    synthesize: (input: KabanSynthesizeInput) =>
      run(input.requestId, "Piper", input.port, async (signal) => {
        const response = await request(`http://127.0.0.1:${input.port}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: input.text }),
          signal,
          redirect: "error",
        });
        const bytes = await readLimited(response, 12_000_000);
        const wav = Buffer.from(bytes);
        if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
          throw new Error("Piper did not return a WAV file");
        }
        return wav.toString("base64");
      }),
    dispose: () => {
      for (const controller of pending.values()) controller.abort();
    },
    cancel: (requestId: string) => {
      pending.get(requestId)?.abort();
    },
  };
}
