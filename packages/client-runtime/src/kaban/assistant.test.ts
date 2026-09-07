import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  KabanReceipts,
  SpokenSentences,
  kabanModel,
  kabanTaskStatus,
  routeKabanUtterance,
  resolveKabanEnvironment,
  speechText,
} from "./assistant.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-personal"),
  driver: ProviderDriverKind.make("codex"),
  version: "1.0.0",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-07T12:00:00.000Z",
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: "gpt-5.6-terra",
      name: "Terra",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "low", label: "Low" }],
          },
        ],
      },
    },
  ],
};

describe("Kaban routing and model selection", () => {
  it("delegates explicit voice commands, preserving the actual task", () => {
    expect(routeKabanUtterance("Кодекс, исправь поиск\nи проверь тесты")).toEqual({
      kind: "delegate",
      text: "исправь поиск\nи проверь тесты",
    });
    expect(routeKabanUtterance("Как работает Codex?")).toEqual({
      kind: "ask",
      text: "Как работает Codex?",
    });
    expect(routeKabanUtterance("добавь фильтр", "delegate")).toEqual({
      kind: "delegate",
      text: "добавь фильтр",
    });
    expect(routeKabanUtterance("Уточни задачу: только TypeScript")).toEqual({
      kind: "followup",
      text: "только TypeScript",
    });
  });
  it("separates stopping speech from stopping work and addresses task numbers", () => {
    expect(routeKabanUtterance("Стоп!")).toEqual({ kind: "silence" });
    expect(routeKabanUtterance("останови задачу 12")).toEqual({ kind: "cancel", taskNumber: 12 });
    expect(routeKabanUtterance("прочитай результат задачи 2")).toEqual({
      kind: "result",
      taskNumber: 2,
    });
    expect(routeKabanUtterance("как там задача?")).toEqual({ kind: "status" });
    expect(() => routeKabanUtterance("  ")).toThrow();
  });
  it("uses the Codex catalog's reasoningEffort option and chosen account", () => {
    expect(kabanModel([provider], provider.instanceId, "gpt-5.6-terra", "low")).toEqual({
      instanceId: provider.instanceId,
      model: "gpt-5.6-terra",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });
  it("never silently changes accounts, models, or reasoning", () => {
    expect(() => kabanModel([provider], "missing", "gpt-5.6-terra", "low")).toThrow(/signed-in/);
    expect(() => kabanModel([provider], provider.instanceId, "missing", "low")).toThrow(
      /unavailable/,
    );
    expect(() => kabanModel([provider], provider.instanceId, "gpt-5.6-terra", "high")).toThrow(
      /reasoning/,
    );
    expect(() =>
      kabanModel(
        [{ ...provider, auth: { status: "unauthenticated" } }],
        provider.instanceId,
        "gpt-5.6-terra",
        "low",
      ),
    ).toThrow(/signed-in/);
    expect(() =>
      kabanModel(
        [{ ...provider, models: [{ ...provider.models[0]!, capabilities: null }] }],
        provider.instanceId,
        "gpt-5.6-terra",
        "low",
      ),
    ).toThrow(/reasoning/);
  });
});

describe("task observations", () => {
  const completed = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed" as const,
      requestedAt: "2026-09-07T12:00:00.000Z",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    },
  };
  it("does not call background work or pending approvals complete", () => {
    expect(kabanTaskStatus(null)).toBe("synchronizing");
    expect(kabanTaskStatus(completed)).toBe("completed");
    expect(kabanTaskStatus({ ...completed, hasPendingApprovals: true })).toBe("needs your input");
    expect(kabanTaskStatus({ ...completed, backgroundLiveness: "working" })).toBe("working");
    expect(kabanTaskStatus({ ...completed, backgroundLiveness: "monitoring" })).toBe("monitoring");
  });
  it("announces once before persistence, after reconnect, and across environments", () => {
    const receipts = new KabanReceipts();
    expect(receipts.claim("local", "thread", "turn", "")).toBe(true);
    expect(receipts.claim("local", "thread", "turn", "")).toBe(false);
    expect(receipts.claim("remote", "thread", "turn", "")).toBe(true);
    expect(new KabanReceipts().claim("local", "thread", "turn", "turn")).toBe(false);
    expect(receipts.claim("local", "thread", "next", "turn")).toBe(true);
  });
});

describe("streamed speech", () => {
  it("waits for complete sentences and never repeats a replayed message", () => {
    const speech = new SpokenSentences();
    expect(speech.take("Сейчас провер", false)).toEqual([]);
    expect(speech.take("Сейчас проверю. Ответ", false)).toEqual(["Сейчас проверю."]);
    expect(speech.take("Сейчас проверю. Ответ", false)).toEqual([]);
    expect(speech.take("Сейчас проверю. Ответ готов!", true)).toEqual(["Ответ готов!"]);
    expect(speech.take("Сейчас проверю. Ответ готов!", true)).toEqual([]);
  });
  it("keeps partial markdown and code out of speech", () => {
    const speech = new SpokenSentences();
    expect(speech.take("Смотри [документацию. ", false)).toEqual([]);
    expect(speech.take("Смотри [документацию. ](https://example.com).", true)).toEqual([
      "Смотри документацию. .",
    ]);
    const code = new SpokenSentences();
    expect(code.take("Пример: ```ts\nrun();", false)).toEqual([]);
    expect(code.take("Пример: ```ts\nrun();\n```", true)).toEqual([
      "Пример: Код — в текстовом ответе.",
    ]);
    expect(speechText("**Готово** https://example.com")).toBe("Готово");
  });
  it("does not replay rewritten answers", () => {
    const speech = new SpokenSentences();
    speech.take("Ответ один.", true);
    expect(speech.take("Другой ответ.", true)).toEqual([]);
  });
});

describe("Kaban environment selection before a project exists", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  it("discovers the single connected account environment without a project", () => {
    expect(
      resolveKabanEnvironment({ activeEnvironmentId: null, availableEnvironmentIds: [local] }),
    ).toBe(local);
  });
  it("uses the active environment when multiple environments are connected", () => {
    expect(
      resolveKabanEnvironment({
        activeEnvironmentId: remote,
        availableEnvironmentIds: [local, remote],
      }),
    ).toBe(remote);
    expect(
      resolveKabanEnvironment({
        activeEnvironmentId: null,
        availableEnvironmentIds: [local, remote],
      }),
    ).toBeUndefined();
  });
  it("preserves an explicit offline environment instead of borrowing another account", () => {
    expect(
      resolveKabanEnvironment({
        savedEnvironmentId: remote,
        activeEnvironmentId: local,
        availableEnvironmentIds: [local],
      }),
    ).toBe(remote);
  });
  it("keeps existing project settings on their own environment", () => {
    expect(
      resolveKabanEnvironment({
        projectEnvironmentId: remote,
        savedEnvironmentId: local,
        activeEnvironmentId: local,
        availableEnvironmentIds: [local, remote],
      }),
    ).toBe(remote);
  });
});
