import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { KabanTranscribeInput } from "@t3tools/contracts/kaban";
import { createLocalSpeechTransport } from "./localSpeech.ts";

const decodeInput = Schema.decodeUnknownSync(KabanTranscribeInput);
const wav = Buffer.alloc(46);
wav.write("RIFF", 0);
wav.write("WAVE", 8);
const input = {
  requestId: "recording",
  port: 8080,
  language: "ru",
  wavBase64: wav.toString("base64"),
};
afterEach(() => vi.useRealTimers());

describe("local speech boundary", () => {
  it("sends a WAV to whisper.cpp on loopback without following redirects", async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const form = init?.body as FormData;
      expect(form.get("language")).toBe("ru");
      expect(form.get("response_format")).toBe("json");
      expect(await (form.get("file") as File).arrayBuffer()).toEqual(
        wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      );
      return Response.json({ text: "  Привет  " });
    });
    expect(await createLocalSpeechTransport(request).transcribe(input)).toEqual({
      ok: true,
      value: "Привет",
    });
    expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8080/inference");
    expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("rejects malformed recordings, invalid ports, and non-transcript responses", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ wrong: "shape" }));
    const speech = createLocalSpeechTransport(request);
    expect((await speech.transcribe({ ...input, wavBase64: "bad" })).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(() => decodeInput({ ...input, port: 80 })).toThrow();
    expect(() => decodeInput({ ...input, port: "8080/path" })).toThrow();
    expect((await speech.transcribe(input)).ok).toBe(false);
  });
  it("reports HTTP failures and bounds engine responses", async () => {
    const failed = createLocalSpeechTransport(async () => new Response("bad", { status: 503 }));
    expect(await failed.transcribe(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining("503"),
    });
    const huge = createLocalSpeechTransport(async () => new Response("x".repeat(256_001)));
    expect(await huge.transcribe(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining("size limit"),
    });
  });
  it("cancels an in-flight request, rejects duplicate IDs, and allows retry after cleanup", async () => {
    const request = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const speech = createLocalSpeechTransport(request);
    const first = speech.transcribe(input);
    expect(await speech.transcribe(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already exists"),
    });
    speech.cancel(input.requestId);
    expect(await first).toMatchObject({ ok: false, error: expect.stringContaining("cancelled") });
    request.mockResolvedValueOnce(Response.json({ text: "retry" }));
    expect(await speech.transcribe(input)).toEqual({ ok: true, value: "retry" });
  });
  it("times out a stalled engine and cancels requests on shutdown", async () => {
    vi.useFakeTimers();
    const speech = createLocalSpeechTransport(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const first = speech.transcribe(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await first).ok).toBe(false);
    const second = speech.transcribe(input);
    speech.dispose();
    expect((await second).ok).toBe(false);
  });
  it("uses Piper's synthesis route and rejects non-audio responses", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(wav));
    const speech = createLocalSpeechTransport(request);
    expect(await speech.synthesize({ requestId: "voice", port: 5000, text: "Привет" })).toEqual({
      ok: true,
      value: wav.toString("base64"),
    });
    expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:5000/synthesize");
    expect(request.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ text: "Привет" }));
    request.mockResolvedValueOnce(Response.json({ error: "no model" }));
    expect((await speech.synthesize({ requestId: "voice", port: 5000, text: "Привет" })).ok).toBe(
      false,
    );
  });
});
