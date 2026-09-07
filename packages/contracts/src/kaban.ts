import * as Schema from "effect/Schema";

const RequestId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const Port = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1024, maximum: 65535 }),
);

export const KabanTranscribeInput = Schema.Struct({
  requestId: RequestId,
  port: Port,
  language: Schema.String.check(Schema.isPattern(/^[a-z]{2,3}$/)),
  // 60 seconds of mono PCM16 at 16 kHz, with room for the WAV header.
  wavBase64: Schema.String.check(Schema.isMaxLength(2_600_000)),
});
export type KabanTranscribeInput = typeof KabanTranscribeInput.Type;

export const KabanSynthesizeInput = Schema.Struct({
  requestId: RequestId,
  port: Port,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
});
export type KabanSynthesizeInput = typeof KabanSynthesizeInput.Type;
export const KabanCancelInput = Schema.Struct({ requestId: RequestId });

export const KabanSpeechResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type KabanSpeechResult = typeof KabanSpeechResult.Type;

export interface KabanSpeechBridge {
  transcribe(input: KabanTranscribeInput): Promise<KabanSpeechResult>;
  synthesize(input: KabanSynthesizeInput): Promise<KabanSpeechResult>;
  cancel(requestId: string): Promise<void>;
}
