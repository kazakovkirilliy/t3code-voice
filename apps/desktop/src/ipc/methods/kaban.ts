import {
  KabanCancelInput,
  KabanSpeechResult,
  KabanSynthesizeInput,
  KabanTranscribeInput,
} from "@t3tools/contracts/kaban";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createLocalSpeechTransport } from "../../kaban/localSpeech.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const installKabanSpeech = Effect.fn("desktop.ipc.kaban.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const speech = createLocalSpeechTransport();
  yield* Effect.addFinalizer(() => Effect.sync(() => speech.dispose()));
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.KABAN_TRANSCRIBE_CHANNEL,
      payload: KabanTranscribeInput,
      result: KabanSpeechResult,
      handler: (input) => Effect.promise(() => speech.transcribe(input)),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.KABAN_SYNTHESIZE_CHANNEL,
      payload: KabanSynthesizeInput,
      result: KabanSpeechResult,
      handler: (input) => Effect.promise(() => speech.synthesize(input)),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.KABAN_CANCEL_CHANNEL,
      payload: KabanCancelInput,
      result: Schema.Void,
      handler: ({ requestId }) => Effect.sync(() => speech.cancel(requestId)),
    }),
  );
});
