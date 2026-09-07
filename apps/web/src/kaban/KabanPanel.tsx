import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MessageId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationThread, OrchestrationThreadShell } from "@t3tools/contracts";
import {
  KABAN_INSTRUCTIONS,
  KabanReceipts,
  SpokenSentences,
  kabanModel,
  kabanTaskStatus,
  routeKabanUtterance,
  speechText,
  type KabanMode,
} from "@t3tools/client-runtime/kaban";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import {
  AudioLinesIcon,
  MicIcon,
  SendIcon,
  SettingsIcon,
  SquareIcon,
  VolumeXIcon,
  XIcon,
} from "lucide-react";
import {
  useProjects,
  useServerConfigs,
  useThreadShell,
  useThreadShellsForProjectRefs,
} from "../state/entities";
import { useEnvironmentThread, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { Button } from "../components/ui/button";
import { SpeechQueue, startRecording, transcribe, type Recording } from "./audio";
import {
  DEFAULT_KABAN_SETTINGS,
  KABAN_OPEN_EVENT,
  KabanRecords,
  KabanSettings,
  type KabanRecord,
} from "./state";

type Snapshot = {
  thread: OrchestrationThread | null;
  shell: OrchestrationThreadShell | null;
  live: boolean;
};
const recordKey = (record: Pick<KabanRecord, "environmentId" | "threadId">) =>
  `${record.environmentId}:${record.threadId}`;
const statusRussian: Record<string, string> = {
  synchronizing: "синхронизация",
  "needs your input": "нужен твой ответ",
  failed: "ошибка",
  working: "выполняется",
  monitoring: "наблюдает",
  interrupted: "остановлена",
  completed: "завершена",
  ready: "готова",
};

function ThreadObserver({
  record,
  onChange,
}: {
  record: KabanRecord;
  onChange: (record: KabanRecord, snapshot: Snapshot) => void;
}) {
  const ref = useMemo(
    () => scopeThreadRef(record.environmentId, record.threadId),
    [record.environmentId, record.threadId],
  );
  const shell = useThreadShell(ref);
  const state = useEnvironmentThread(record.environmentId, shell ? record.threadId : null);
  const thread = Option.getOrNull(state.data);
  useEffect(() => {
    onChange(record, { thread, shell, live: state.status === "live" });
  }, [onChange, record, shell, state.status, thread]);
  return null;
}

const EMPTY_RECORDS: readonly KabanRecord[] = [];
const fieldClass = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";

export default function KabanPanel() {
  const navigate = useNavigate();
  const projects = useProjects();
  const configs = useServerConfigs();
  const [settings, setSettings] = useLocalStorage(
    "t3code:kaban:settings:v1",
    DEFAULT_KABAN_SETTINGS,
    KabanSettings,
  );
  const [records, setRecords] = useLocalStorage(
    "t3code:kaban:threads:v1",
    EMPTY_RECORDS,
    KabanRecords,
  );
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  const [activated, setActivated] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<KabanMode>("ask");
  const [selectedTask, setSelectedTask] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [captureState, setCaptureState] = useState<
    "idle" | "preparing" | "recording" | "transcribing"
  >("idle");
  const [speaking, setSpeaking] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const recording = useRef<Recording | null>(null);
  const capture = useRef<AbortController | null>(null);
  const submitLock = useRef(false);
  const receipts = useRef(new KabanReceipts());
  const chunks = useRef(new Map<string, SpokenSentences>());
  const suppressSpeech = useRef(new Set<string>());
  const settingsRef = useRef(settings);
  const activeRef = useRef(activated);
  const recordsRef = useRef(records);
  const speaker = useMemo(() => new SpeechQueue((message) => setError(message), setSpeaking), []);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const projectKey = (project: (typeof projects)[number]) =>
    `${project.environmentId}:${project.id}`;
  const project =
    projects.find((item) => projectKey(item) === settings.projectKey) ??
    (settings.projectKey ? undefined : projects[0]);
  const projectRefs = useMemo(
    () => (project ? [scopeProjectRef(project.environmentId, project.id)] : []),
    [project],
  );
  const projectThreads = useThreadShellsForProjectRefs(projectRefs);
  const providers = project ? (configs.get(project.environmentId)?.providers ?? []) : [];
  const codexProviders = providers.filter(
    (item) => item.driver === "codex" && item.enabled && item.installed,
  );
  const provider =
    codexProviders.find((item) => item.instanceId === settings.instanceId) ??
    (settings.instanceId ? undefined : codexProviders[0]);
  const assistant = records.find(
    (item) =>
      item.kind === "assistant" &&
      item.environmentId === project?.environmentId &&
      item.projectId === project.id,
  );
  const tasks = records.filter(
    (item) =>
      item.kind === "task" &&
      item.environmentId === project?.environmentId &&
      item.projectId === project.id,
  );
  const task = tasks.find((item) => item.threadId === selectedTask) ?? tasks.at(-1);
  const assistantSnapshot = assistant ? snapshots[recordKey(assistant)] : undefined;
  const assistantStatus = !assistantSnapshot?.live
    ? "synchronizing"
    : kabanTaskStatus(assistantSnapshot.shell);
  // The accepted command can reach the UI before its turn-start event.
  const assistantBusy =
    !!assistant &&
    (assistantStatus === "working" ||
      assistantStatus === "needs your input" ||
      assistantStatus === "synchronizing" ||
      (!assistant.notifiedTurnId &&
        (!assistantSnapshot?.shell?.latestTurn ||
          assistantSnapshot.shell.latestTurn.requestedAt < assistant.speakAfter)));
  const bridge = window.desktopBridge?.kabanSpeech;

  const say = useCallback(
    (value: string) => {
      const current = settingsRef.current;
      if (activeRef.current && current.speak)
        speaker.say(value, {
          engine: current.engine,
          port: current.piperPort,
          voice: current.voice,
        });
    },
    [speaker],
  );

  const stopSpeech = useCallback(() => {
    speaker.stop();
    for (const record of recordsRef.current) suppressSpeech.current.add(recordKey(record));
  }, [speaker]);

  const observe = useCallback(
    (record: KabanRecord, snapshot: Snapshot) => {
      setSnapshots((previous) => {
        const old = previous[recordKey(record)];
        if (
          old?.thread === snapshot.thread &&
          old?.shell === snapshot.shell &&
          old?.live === snapshot.live
        )
          return previous;
        return { ...previous, [recordKey(record)]: snapshot };
      });
      if (!snapshot.live || !snapshot.thread || !snapshot.shell || !activeRef.current) return;
      const latest = snapshot.thread.latestTurn;
      if (!latest || latest.requestedAt < record.speakAfter) return;
      const messages = snapshot.thread.messages.filter(
        (message) => message.role === "assistant" && message.turnId === latest.turnId,
      );
      if (
        record.kind === "assistant" &&
        !suppressSpeech.current.has(recordKey(record)) &&
        record.notifiedTurnId !== latest.turnId
      ) {
        for (const message of messages) {
          const key = `${recordKey(record)}:${message.id}`;
          let splitter = chunks.current.get(key);
          if (!splitter) {
            splitter = new SpokenSentences();
            chunks.current.set(key, splitter);
          }
          for (const sentence of splitter.take(message.text, !message.streaming)) say(sentence);
        }
      }
      const status = kabanTaskStatus(snapshot.shell);
      if (
        !["completed", "failed", "interrupted"].includes(status) ||
        record.notifiedTurnId === latest.turnId
      )
        return;
      if (
        status === "completed" &&
        latest.assistantMessageId &&
        !messages.some((message) => message.id === latest.assistantMessageId && !message.streaming)
      )
        return;
      if (
        !receipts.current.claim(
          record.environmentId,
          record.threadId,
          latest.turnId,
          record.notifiedTurnId,
        )
      )
        return;
      // Commit the receipt before speaking; reconnects must not announce it twice.
      setRecords((previous) =>
        previous.map((item) =>
          item.threadId === record.threadId && item.environmentId === record.environmentId
            ? { ...item, notifiedTurnId: latest.turnId }
            : item,
        ),
      );
      if (record.kind === "task") {
        const summary = `Задача ${record.number} ${statusRussian[status]}. ${record.title}`;
        setNotice(summary);
        say(summary);
      } else if (status === "failed") {
        setError(
          snapshot.thread.session?.lastError ??
            "Assistant turn failed. Open its thread for details.",
        );
      }
    },
    [say, setRecords],
  );

  const togglePanel = useCallback(() => {
    if (openRef.current) {
      setContinuous(false);
      capture.current?.abort();
    }
    setOpen(!openRef.current);
    setActivated(true);
  }, []);

  useEffect(() => {
    const show = () => {
      setOpen(true);
      setActivated(true);
    };
    const shortcut = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
        return;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.code === "KeyK" &&
        !event.repeat &&
        !event.defaultPrevented
      ) {
        event.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener(KABAN_OPEN_EVENT, show);
    window.addEventListener("keydown", shortcut);
    const updateVoices = () =>
      setVoices(window.speechSynthesis?.getVoices().filter((item) => item.localService) ?? []);
    updateVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", updateVoices);
    return () => {
      activeRef.current = false;
      window.removeEventListener(KABAN_OPEN_EVENT, show);
      window.removeEventListener("keydown", shortcut);
      window.speechSynthesis?.removeEventListener("voiceschanged", updateVoices);
      capture.current?.abort();
      speaker.stop();
    };
  }, [speaker, togglePanel]);

  const showThread = (record: KabanRecord) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: record.environmentId, threadId: record.threadId },
    });
  };

  const cancelTask = async (target: KabanRecord) => {
    const snapshot = snapshots[recordKey(target)];
    if (!snapshot?.live || !snapshot.thread?.latestTurn)
      throw new Error("Wait for the task to synchronize before stopping it.");
    if (!["working", "needs your input", "monitoring"].includes(kabanTaskStatus(snapshot.shell)))
      throw new Error("This turn is already stopped.");
    const result = await interruptTurn({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, turnId: snapshot.thread.latestTurn.turnId },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    setNotice(`Остановка задачи ${target.number} запрошена.`);
  };

  const send = async (input: string, requestedMode = mode) => {
    if (submitLock.current) return;
    const intent = routeKabanUtterance(input, requestedMode);
    if (intent.kind === "silence") {
      stopSpeech();
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      if (!project) throw new Error("Choose an available project first.");
      if (
        intent.kind === "status" ||
        intent.kind === "result" ||
        intent.kind === "cancel" ||
        intent.kind === "followup"
      ) {
        const number = "taskNumber" in intent ? intent.taskNumber : undefined;
        const target = number === undefined ? task : tasks.find((item) => item.number === number);
        if (!target) throw new Error("Choose a delegated task first.");
        const snapshot = snapshots[recordKey(target)];
        if (intent.kind === "cancel") {
          await cancelTask(target);
          setText("");
          return;
        }
        if (intent.kind === "status" || intent.kind === "result") {
          const answer =
            intent.kind === "status"
              ? `Задача ${target.number}: ${snapshot?.live ? statusRussian[kabanTaskStatus(snapshot.shell)] : "связь с сервером восстанавливается"}. ${snapshot?.shell?.planProgress?.step ?? ""}`
              : snapshot?.live
                ? (snapshot.thread?.messages
                    .slice()
                    .reverse()
                    .find(
                      (item) =>
                        item.role === "assistant" &&
                        !item.streaming &&
                        item.turnId === snapshot.thread?.latestTurn?.turnId,
                    )?.text ?? "Результата пока нет.")
                : "Сначала дождись подключения к серверу.";
          setNotice(answer);
          say(speechText(answer));
          setText("");
          return;
        }
      }
      if (!provider) throw new Error("Choose a Codex account in Kaban settings.");
      if (intent.kind !== "ask" && intent.kind !== "delegate" && intent.kind !== "followup") return;
      if (intent.kind === "ask" && assistantBusy)
        throw new Error("The assistant is answering. Stop its turn or wait before asking again.");
      if (
        intent.kind === "delegate" &&
        tasks.some((item) => {
          const snapshot = snapshots[recordKey(item)];
          return (
            !snapshot?.live ||
            ["working", "needs your input", "synchronizing"].includes(
              kabanTaskStatus(snapshot.shell),
            )
          );
        })
      )
        throw new Error(
          "A delegated task is already using this workspace. Wait, or select another project.",
        );
      if (
        intent.kind === "delegate" &&
        projectThreads.some(
          (item) =>
            !item.worktreePath &&
            ["working", "needs your input", "monitoring"].includes(kabanTaskStatus(item)),
        )
      )
        throw new Error(
          "Another thread is using this project folder. Wait for it to finish or choose another project.",
        );
      const followup = intent.kind === "followup";
      const isTask = intent.kind !== "ask";
      const existing = followup ? task : isTask ? undefined : assistant;
      if (existing && !snapshots[recordKey(existing)]?.live)
        throw new Error(
          "Wait for the thread to reconnect. If submission failed, open it in T3 before retrying.",
        );
      const modelSelection = kabanModel(
        providers,
        provider.instanceId,
        isTask ? settings.taskModel : settings.questionModel,
        isTask ? settings.taskEffort : settings.questionEffort,
      );
      const threadId = existing?.threadId ?? ThreadId.make(crypto.randomUUID());
      const createdAt = new Date().toISOString();
      const speakAfter =
        followup &&
        existing &&
        kabanTaskStatus(snapshots[recordKey(existing)]?.shell ?? null) === "working"
          ? existing.speakAfter
          : createdAt;
      const number = isTask
        ? (existing?.number ?? Math.max(0, ...records.map((item) => item.number)) + 1)
        : 0;
      const title = isTask ? `Kaban · ${intent.text.slice(0, 80)}` : "Kaban · Conversation";
      const record: KabanRecord = {
        threadId,
        projectId: project.id,
        environmentId: project.environmentId,
        kind: isTask ? "task" : "assistant",
        title,
        number,
        speakAfter,
        notifiedTurnId: "",
      };
      suppressSpeech.current.delete(recordKey(record));
      setRecords((previous) =>
        existing
          ? previous.map((item) =>
              item.threadId === threadId && item.environmentId === project.environmentId
                ? { ...item, speakAfter, notifiedTurnId: "" }
                : item,
            )
          : [...previous, record],
      );
      const result = await startTurn({
        environmentId: project.environmentId,
        input: {
          threadId,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text:
              !isTask && !existing ? `${KABAN_INSTRUCTIONS}\n\nUser: ${intent.text}` : intent.text,
            attachments: [],
          },
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt,
          ...(!existing
            ? {
                bootstrap: {
                  createThread: {
                    projectId: project.id,
                    title,
                    modelSelection,
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    createdAt,
                  },
                },
              }
            : {}),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setText("");
      setMode("ask");
      if (isTask) {
        setSelectedTask(threadId);
        setNotice(`Задача ${number} отправлена в Codex.`);
        say(`Задача ${number} отправлена. Я сообщу о завершении.`);
      } else setNotice("");
    } catch (cause) {
      setContinuous(false);
      throw cause;
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const sendRef = useRef(send);
  const selectionRef = useRef("");

  const listen = async () => {
    if (capture.current || !bridge) return;
    const selection = selectionRef.current;
    const capturedMode = mode;
    const controller = new AbortController();
    capture.current = controller;
    stopSpeech();
    setError(null);
    setCaptureState("preparing");
    try {
      const captureSession = await startRecording(controller.signal);
      recording.current = captureSession;
      setCaptureState("recording");
      const wav = await captureSession.result;
      recording.current = null;
      setCaptureState("transcribing");
      const started = performance.now();
      const transcript = await transcribe(bridge, wav, settings.whisperPort, controller.signal);
      setText(transcript);
      setNotice(`Распознано за ${((performance.now() - started) / 1000).toFixed(1)} с`);
      if (selection !== selectionRef.current)
        throw new Error(
          "Selection changed during recording. Review the transcript before sending.",
        );
      await sendRef.current(transcript, capturedMode);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setContinuous(false);
      }
    } finally {
      capture.current = null;
      recording.current = null;
      setCaptureState("idle");
    }
  };
  const listenRef = useRef(listen);
  useLayoutEffect(() => {
    openRef.current = open;
    settingsRef.current = settings;
    activeRef.current = activated;
    recordsRef.current = records;
    sendRef.current = send;
    listenRef.current = listen;
    selectionRef.current = JSON.stringify([
      project?.environmentId,
      project?.id,
      provider?.instanceId,
      task?.threadId,
    ]);
  });

  useEffect(() => {
    if (
      !continuous ||
      !open ||
      !activated ||
      submitting ||
      captureState !== "idle" ||
      speaking ||
      assistantBusy ||
      showSettings
    )
      return;
    // Let speaker playback and the room's echo settle before opening the microphone again.
    const timer = setTimeout(() => {
      void listenRef.current();
    }, 350);
    return () => clearTimeout(timer);
  }, [
    activated,
    assistantBusy,
    captureState,
    continuous,
    open,
    showSettings,
    speaking,
    submitting,
  ]);

  const pause = () => {
    activeRef.current = false;
    setContinuous(false);
    capture.current?.abort();
    stopSpeech();
    setActivated(false);
    setOpen(false);
  };
  const forget = (record: KabanRecord) => {
    stopSpeech();
    setContinuous(false);
    setRecords((previous) => previous.filter((item) => recordKey(item) !== recordKey(record)));
    setNotice("Tracking removed. The thread and any running work remain in T3.");
  };
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const update = <K extends keyof KabanSettings>(key: K, value: KabanSettings[K]) =>
    setSettings((previous) => ({ ...previous, [key]: value }));

  return (
    <>
      {activated &&
        records.map((record) => (
          <ThreadObserver
            key={`${record.environmentId}:${record.threadId}`}
            record={record}
            onChange={observe}
          />
        ))}
      <Button
        variant="outline"
        size="sm"
        className="fixed bottom-4 left-4 z-50 shadow-md"
        aria-expanded={open}
        aria-controls="kaban-panel"
        onClick={togglePanel}
      >
        <AudioLinesIcon className="size-4" /> Kaban{" "}
        {speaking ? "· speaking" : captureState === "recording" ? "· listening" : ""}
      </Button>
      {open && (
        <section
          id="kaban-panel"
          aria-label="Kaban voice assistant"
          className="fixed bottom-16 left-4 z-50 flex max-h-[calc(100dvh-6rem)] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
        >
          <header className="flex items-center gap-2 border-b border-border p-3">
            <AudioLinesIcon className="size-5 text-primary" />
            <div className="flex-1">
              <strong>Kaban</strong>
              <p className="text-xs text-muted-foreground">Voice, answers & delegated tasks</p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Kaban settings"
              disabled={captureState !== "idle" || submitting}
              onClick={() => setShowSettings((value) => !value)}
            >
              <SettingsIcon className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Stop voice and close Kaban"
              onClick={pause}
            >
              <XIcon className="size-4" />
            </Button>
          </header>
          <div className="overflow-y-auto p-3 space-y-3">
            <label className="block text-xs text-muted-foreground">
              Project
              <select
                className={fieldClass}
                value={project ? projectKey(project) : ""}
                disabled={captureState !== "idle" || submitting}
                onChange={(event) => {
                  stopSpeech();
                  setContinuous(false);
                  update("projectKey", event.target.value);
                  update("instanceId", "");
                  setSelectedTask("");
                }}
              >
                {!project && <option value="">Choose a project</option>}
                {projects.map((item) => (
                  <option key={projectKey(item)} value={projectKey(item)}>
                    {item.title} · {item.environmentId}
                  </option>
                ))}
              </select>
            </label>
            {showSettings && (
              <fieldset
                disabled={captureState !== "idle" || submitting}
                className="space-y-2 rounded-lg border border-border p-3"
              >
                <label className="block text-xs">
                  Codex account
                  <select
                    className={fieldClass}
                    value={provider?.instanceId ?? ""}
                    onChange={(event) => update("instanceId", event.target.value)}
                  >
                    <option value="">Choose account</option>
                    {codexProviders.map((item) => (
                      <option key={item.instanceId} value={item.instanceId}>
                        {item.displayName ?? item.instanceId}
                      </option>
                    ))}
                  </select>
                </label>
                {(
                  [
                    ["questionModel", "questionEffort", "Answers"],
                    ["taskModel", "taskEffort", "Tasks"],
                  ] as const
                ).map(([modelKey, effortKey, label]) => (
                  <div key={modelKey} className="grid grid-cols-[1fr_90px] gap-2">
                    <label className="text-xs">
                      {label}
                      <select
                        className={fieldClass}
                        value={settings[modelKey]}
                        onChange={(event) => update(modelKey, event.target.value)}
                      >
                        {!provider?.models.some((item) => item.slug === settings[modelKey]) && (
                          <option value={settings[modelKey]}>
                            {settings[modelKey]} · unavailable
                          </option>
                        )}
                        {provider?.models.map((item) => (
                          <option key={item.slug} value={item.slug}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs">
                      Reasoning
                      <select
                        className={fieldClass}
                        value={settings[effortKey]}
                        onChange={(event) => update(effortKey, event.target.value)}
                      >
                        {["low", "medium", "high", "xhigh", "max"].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ))}
                <label className="block text-xs">
                  Speech
                  <select
                    className={fieldClass}
                    value={settings.engine}
                    onChange={(event) => {
                      stopSpeech();
                      update("engine", event.target.value === "piper" ? "piper" : "system");
                    }}
                  >
                    <option value="system">Local system voice</option>
                    <option value="piper">Local Piper voice</option>
                  </select>
                </label>
                {settings.engine === "system" && (
                  <label className="block text-xs">
                    Voice
                    <select
                      className={fieldClass}
                      value={settings.voice}
                      onChange={(event) => update("voice", event.target.value)}
                    >
                      <option value="">Russian system default</option>
                      {voices.map((voice) => (
                        <option key={voice.voiceURI} value={voice.name}>
                          {voice.name} · {voice.lang}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["whisperPort", "Whisper port"],
                      ["piperPort", "Piper port"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="text-xs">
                      {label}
                      <input
                        className={fieldClass}
                        type="number"
                        min={1024}
                        max={65535}
                        value={settings[key]}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isInteger(value) && value >= 1024 && value <= 65535)
                            update(key, value);
                        }}
                      />
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Speech engines run on this computer.{" "}
                  <a
                    className="underline"
                    href="https://github.com/kazakovkirilliy/t3code-voice/blob/feat/kaban-voice-assistant/docs/user/kaban.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Setup guide
                  </a>
                </p>
              </fieldset>
            )}
            <div className="flex flex-wrap gap-2 text-xs">
              <label className="flex gap-1.5 items-center">
                <input
                  type="checkbox"
                  checked={settings.speak}
                  onChange={(event) => {
                    update("speak", event.target.checked);
                    if (!event.target.checked) stopSpeech();
                  }}
                />
                Speak answers
              </label>
              <label className="flex gap-1.5 items-center">
                <input
                  type="checkbox"
                  checked={continuous}
                  disabled={!bridge}
                  onChange={(event) => {
                    setContinuous(event.target.checked);
                    if (!event.target.checked) capture.current?.abort();
                  }}
                />
                Conversation mode
              </label>
              <Button size="sm" variant="ghost" onClick={stopSpeech}>
                <VolumeXIcon className="size-3" />
                Quiet
              </Button>
            </div>
            <div className="flex gap-1" aria-label="Message mode">
              {(
                [
                  ["ask", "Ask"],
                  ["delegate", "Delegate"],
                  ["followup", "Follow up"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant={mode === value ? "secondary" : "ghost"}
                  aria-pressed={mode === value}
                  disabled={captureState !== "idle" || submitting}
                  onClick={() => setMode(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void send(text).catch(fail);
              }}
            >
              <textarea
                aria-label="Message to Kaban"
                className={`${fieldClass} min-h-20 resize-y`}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Спроси что-нибудь. Или: «Кодекс, исправь…»"
                disabled={captureState !== "idle"}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={captureState === "recording" ? "secondary" : "outline"}
                  disabled={
                    !bridge ||
                    submitting ||
                    captureState === "preparing" ||
                    captureState === "transcribing"
                  }
                  onClick={() => (recording.current ? recording.current.finish() : void listen())}
                >
                  <MicIcon className="size-4" />
                  {captureState === "recording"
                    ? "Finish phrase"
                    : captureState === "transcribing"
                      ? "Transcribing…"
                      : "Speak"}
                </Button>
                {captureState !== "idle" && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setContinuous(false);
                      capture.current?.abort();
                    }}
                  >
                    Cancel
                  </Button>
                )}
                <Button
                  type="submit"
                  className="ml-auto"
                  disabled={submitting || !text.trim() || captureState !== "idle"}
                >
                  <SendIcon className="size-4" />
                  Send
                </Button>
              </div>
            </form>
            {!bridge && (
              <p className="text-xs text-muted-foreground">
                Text works here. Local microphone and Piper support require the Kaban desktop build.
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 p-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            {notice && (
              <p
                role="status"
                className="whitespace-pre-wrap rounded-md bg-muted p-2 text-sm max-h-48 overflow-auto"
              >
                {notice}
              </p>
            )}
            {assistant && (
              <div className="space-y-2 border-t border-border pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Conversation ·{" "}
                    {assistantStatus === "completed" && assistantBusy
                      ? "starting"
                      : assistantStatus}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => showThread(assistant)}>
                    Open thread
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={submitting || captureState !== "idle"}
                    onClick={() => forget(assistant)}
                  >
                    New chat
                  </Button>
                  {assistantBusy && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        stopSpeech();
                        void cancelTask(assistant).catch(fail);
                      }}
                    >
                      Stop
                    </Button>
                  )}
                </div>
                <div className="max-h-48 overflow-auto text-sm space-y-2">
                  {assistantSnapshot?.thread?.messages
                    .filter((message) => message.role === "assistant")
                    .slice(-3)
                    .map((message) => (
                      <p key={message.id} className="whitespace-pre-wrap">
                        {message.text}
                      </p>
                    ))}
                </div>
              </div>
            )}
            {tasks.length > 0 && (
              <div className="space-y-2 border-t border-border pt-2">
                <h3 className="text-sm font-medium">Delegated tasks</h3>
                {tasks.map((item) => (
                  <div
                    key={item.threadId}
                    className={`rounded-lg border p-2 ${task?.threadId === item.threadId ? "border-primary/50" : "border-border"}`}
                  >
                    <button
                      type="button"
                      className="w-full text-left text-sm"
                      disabled={captureState !== "idle" || submitting}
                      onClick={() => setSelectedTask(item.threadId)}
                    >
                      #{item.number} {item.title.replace(/^Kaban · /, "")}
                      <span className="block text-xs text-muted-foreground">
                        {snapshots[recordKey(item)]?.live
                          ? kabanTaskStatus(snapshots[recordKey(item)]?.shell ?? null)
                          : "synchronizing"}
                      </span>
                    </button>
                    <div className="flex flex-wrap gap-1 mt-1">
                      <Button size="sm" variant="ghost" onClick={() => showThread(item)}>
                        Open
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={captureState !== "idle" || submitting}
                        onClick={() => {
                          setSelectedTask(item.threadId);
                          setMode("followup");
                        }}
                      >
                        Follow up
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void send(`результат ${item.number}`).catch(fail)}
                      >
                        Read result
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void cancelTask(item).catch(fail)}
                      >
                        <SquareIcon className="size-3" />
                        Stop
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={submitting || captureState !== "idle"}
                        onClick={() => forget(item)}
                      >
                        Forget
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
