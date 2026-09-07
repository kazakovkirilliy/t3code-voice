import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export const KabanRecord = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  kind: Schema.Literals(["assistant", "task"]),
  title: Schema.String,
  number: Schema.Number,
  speakAfter: Schema.String,
  notifiedTurnId: Schema.String,
});
export type KabanRecord = typeof KabanRecord.Type;
export const KabanRecords = Schema.Array(KabanRecord);
export const KabanSettings = Schema.Struct({
  projectKey: Schema.String,
  instanceId: Schema.String,
  questionModel: Schema.String,
  taskModel: Schema.String,
  questionEffort: Schema.String,
  taskEffort: Schema.String,
  whisperPort: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1024, maximum: 65535 }),
  ),
  piperPort: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1024, maximum: 65535 }),
  ),
  engine: Schema.Literals(["system", "piper"]),
  voice: Schema.String,
  speak: Schema.Boolean,
});
export type KabanSettings = typeof KabanSettings.Type;
export const DEFAULT_KABAN_SETTINGS: KabanSettings = {
  projectKey: "",
  instanceId: "",
  questionModel: "gpt-5.6-terra",
  taskModel: "gpt-5.6-sol",
  questionEffort: "low",
  taskEffort: "medium",
  whisperPort: 8080,
  piperPort: 5000,
  engine: "system",
  voice: "",
  speak: true,
};
export const KABAN_OPEN_EVENT = "t3code:open-kaban";
export function openKaban(): void {
  window.dispatchEvent(new Event(KABAN_OPEN_EVENT));
}
