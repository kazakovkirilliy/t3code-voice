import { act, createElement, useState, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NoSpeechDetected, type Recording } from "./audio";
import KabanPanel from "./KabanPanel";

const mocks = vi.hoisted(() => ({
  record: vi.fn<(signal: AbortSignal) => Promise<Recording>>(),
  transcribe: vi.fn(),
  command: vi.fn(),
  busy: (_value: boolean) => {},
  configs: new Map([
    [
      "local",
      {
        environment: { label: "Mac" },
        providers: [
          {
            driver: "codex",
            instanceId: "codex",
            installed: true,
            enabled: true,
            models: [{ slug: "gpt-5.6-terra", name: "Terra" }],
          },
        ],
      },
    ],
  ]),
  projects: [{ id: "project", environmentId: "local", title: "Project" }],
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../state/entities", () => ({
  useActiveEnvironmentId: () => "local",
  useProjects: () => mocks.projects,
  useServerConfigs: () => mocks.configs,
  useThreadShell: () => null,
  useThreadShellsForProjectRefs: () => [],
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { startTurn: {}, interruptTurn: {} },
  useEnvironmentThread: vi.fn(),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("../hooks/useLocalStorage", () => ({
  useLocalStorage: (_key: string, initial: unknown) => useState(initial),
}));
vi.mock("../components/ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) =>
    createElement("button", props),
}));
vi.mock("./audio", async (original) => ({
  ...(await original<typeof import("./audio")>()),
  startRecording: (signal: AbortSignal) => mocks.record(signal),
  transcribe: mocks.transcribe,
  SpeechQueue: class {
    constructor(_onError: (error: string) => void, onBusy: (busy: boolean) => void) {
      mocks.busy = onBusy;
    }
    stop() {
      mocks.busy(false);
    }
    say() {}
  },
}));

let renderer: ReactTestRenderer | undefined;
let rejectRecording: (error: Error) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const window = Object.assign(new EventTarget(), {
    desktopBridge: { kabanSpeech: {} },
    speechSynthesis: Object.assign(new EventTarget(), { getVoices: () => [] }),
  });
  vi.stubGlobal("window", window);
  mocks.record.mockImplementation(async (signal) => {
    const result = new Promise<Uint8Array>((_resolve, reject) => {
      rejectRecording = reject;
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    return { result, finish() {}, cancel() {} };
  });
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openPanel() {
  await act(async () => {
    renderer = create(<KabanPanel />);
  });
  await act(async () => {
    window.dispatchEvent(new Event("t3code:open-kaban"));
  });
}

function conversationToggle() {
  return renderer!.root
    .findAllByType("input")
    .find(
      (input) =>
        input.props.type === "checkbox" && input.parent?.children.includes("Conversation mode"),
    )!;
}

async function enable() {
  await act(async () => {
    conversationToggle().props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
}

describe("hands-free conversation", () => {
  it("starts listening with settings expanded and rearms after consecutive silent recordings", async () => {
    await openPanel();
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Kaban settings" }).props.onClick();
    });
    await enable();
    expect(mocks.record).toHaveBeenCalledTimes(1);
    for (let cycle = 0; cycle < 2; cycle++) {
      await act(async () => {
        rejectRecording(new NoSpeechDetected());
      });
      expect(conversationToggle().props.checked).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect(mocks.record).toHaveBeenCalledTimes(cycle + 2);
    }
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it("waits for playback to finish before reopening the microphone", async () => {
    await openPanel();
    await act(async () => {
      mocks.busy(true);
    });
    await enable();
    expect(mocks.record).not.toHaveBeenCalled();
    await act(async () => {
      mocks.busy(false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(mocks.record).toHaveBeenCalledOnce();
  });

  it("cancels capture and does not rearm when conversation mode is switched off", async () => {
    await openPanel();
    await enable();
    const signal = mocks.record.mock.calls[0]![0];
    await act(async () => {
      conversationToggle().props.onChange({ target: { checked: false } });
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(conversationToggle().props.checked).toBe(false);
  });

  it("stops retrying after a microphone failure", async () => {
    await openPanel();
    await enable();
    await act(async () => {
      rejectRecording(new Error("Microphone disconnected"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(conversationToggle().props.checked).toBe(false);
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(renderer!.root.findByProps({ role: "alert" }).children).toContain(
      "Microphone disconnected",
    );
  });
});
