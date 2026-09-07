# Kaban voice assistant

Kaban lets you ask questions aloud, hear and read answers, and delegate work to a
separate Codex thread. It uses the Codex account already configured in T3. Speech
recognition and playback run on your computer; the language models use your
provider connection and its normal usage limits.

## Start this fork

Use Node 24 and install `vp` following the [development setup](../../README.md#install-vp).
In your checkout:

```sh
git switch feat/kaban-voice-assistant
vp i
vp run dev:desktop
```

The upstream desktop download and `npx t3@latest` do not contain Kaban. This feature
is available in this fork's Electron build. Its web build supports typed messages
and task tracking; microphone capture and Piper require Electron. The separate
mobile app does not yet include the Kaban panel.

Configure and sign in to a [Codex provider](providers-codex.md), add a project, and
open **Kaban** or run **Open Kaban voice assistant** from the command palette.
`Cmd/Ctrl+Shift+K` toggles the panel. Choose an environment first; its Codex accounts are available even before you add a project.
Use **Add project** in Kaban if no folder is configured. In Kaban settings, choose your project,
Codex account, answer model, and task model.

Defaults are `gpt-5.6-terra` with low reasoning for answers and `gpt-5.6-sol` with
medium reasoning for tasks. They must appear in that account's model catalog.
Choose an available model if either is unavailable. This uses Codex's model access;
it does not automate the ChatGPT website or guarantee access to its Instant model.

## Recognize Russian speech locally

Install a C++ compiler and CMake, then build [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
Run these commands in a separate directory from T3:

```sh
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
sh ./models/download-ggml-model.sh small
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j
./build/bin/whisper-server --host 127.0.0.1 --port 8080 -m models/ggml-small.bin -l ru
```

Keep that process running. Use a multilingual model, without the `.en` suffix.
`base` uses less memory and can respond faster; compare recognition on your own
microphone. Kaban expects whisper.cpp's [WAV transcription endpoint](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server).
If you change the port, change **Whisper port** in Kaban too.

Click **Speak** and allow microphone access. The phrase is sent after about 700 ms
of silence; **Finish phrase** sends it sooner. Capture ends after 60 seconds, or
after 10 seconds without speech. **Cancel** discards a recording or pending
transcription. Audio recordings are not saved by Kaban. Transcribed messages become
normal T3 thread history and are sent to the selected model.

## Choose a voice

The default uses an installed local Russian system voice. Install one in your OS
speech settings, then choose it in Kaban. Remote system voices are excluded.

For Piper, install its [HTTP server](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_HTTP.md)
in a separate directory. For example, using the [Irina voice](https://huggingface.co/rhasspy/piper-voices/tree/v1.0.0/ru/ru_RU/irina/medium):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install 'piper-tts[http]'
.venv/bin/python -m piper.download_voices ru_RU-irina-medium
.venv/bin/python -m piper.http_server -m ru_RU-irina-medium --host 127.0.0.1 --port 5000
```

On Windows use `.venv\Scripts\python.exe`. Select **Local Piper voice** in Kaban.
The server must support `POST /synthesize` returning WAV; upgrade Piper if that
route returns 404. Keep both speech servers bound to `127.0.0.1`.

Answers begin playing at sentence boundaries while text arrives. Code blocks and
URLs stay in the written answer. **Quiet** stops current speech; **Speak** also
interrupts playback before recording. Actual response time depends on your speech
model, hardware, network, and Codex session startup.

**Conversation mode** reopens the microphone after each answer, including while
Kaban settings are expanded. Quiet periods do not disable it: after a silent
recording, it starts listening again without sending anything to Whisper or Codex.
The status below the toggle shows whether it is listening, transcribing, or waiting.
It pauses during
playback and while the assistant is working or needs approval. There is no wake
word or voice interruption during playback yet. Collapse the panel to stop
listening while keeping task notifications active. Close with **×** to pause all
Kaban voice activity. Microphone, transcription, and submission errors stop conversation mode until you
enable it again; silence alone does not.

## Delegate and follow work

| Say or type                             | Result                                            |
| --------------------------------------- | ------------------------------------------------- |
| `Какая сегодня погода в Москве?`        | An answer in the conversation thread              |
| `Кодекс, исправь поиск и проверь тесты` | A separate coding task                            |
| `Статус задачи 2`                       | The actual current task status                    |
| `Уточни задачу: используй TypeScript`   | A follow-up in the selected task                  |
| `Прочитай результат задачи 2`           | Read the latest available response from that task |
| `Останови задачу 2`                     | Request interruption of that task                 |
| `Стоп`                                  | Stop speech                                       |

You can also choose **Delegate** before speaking or typing. Ordinary messages in
**Ask** remain in the conversation; task delegation uses an explicit command or
the selected mode. Without a number, task commands address the selected task.

Tasks use the selected project's folder. Kaban blocks another delegation while a
known task or another T3 thread is using that folder. Use separate projects or T3's
worktree workflow for parallel edits. **Open** takes you to the full thread, where
you can review tool calls, diffs, approval requests, and questions. New Kaban turns
use T3's **Approval required** mode. Search, files, terminal access, and browser
actions use the provider's existing tools and permissions; browser actions need a
connected T3 desktop browser host. Kaban does not add general OS mouse control.

Kaban observes server events while active and announces completion, interruption,
or failure once. Tasks continue on the T3 server when the panel is closed; reopen
Kaban to resume monitoring. **Forget** only removes a task from the panel; it does
not stop or delete it. **New chat** starts fresh next time you ask and leaves the
previous conversation in T3. If sending fails during a disconnection, open the
thread and check whether the request arrived before sending it again.

Panel preferences and tracked thread IDs are local to this client. Full threads
remain on their environment's server. For remote environments, speech stays on the
computer running Electron, while agent tools operate on the selected remote machine.

## Troubleshooting

- **No local voice:** install a Russian OS voice, reopen Kaban, or use Piper.
- **Cannot connect to Whisper/Piper:** T3 does not install or start these servers
  automatically. Run the corresponding command above on the computer running
  Electron and keep that terminal open. Check the server terminal and the configured
  port. On macOS, port 5000 can already be occupied; choose another port for Piper.
- **Microphone denied:** allow T3 Code (or Electron during development) in OS
  microphone permissions, then restart the desktop app.
- **Needs your input:** open the thread and answer the pending approval or question.
- **Synchronizing:** reconnect that T3 environment. No new request is sent while
  an existing conversation is disconnected.
- **Slow first answer:** leave the speech servers running so models remain loaded;
  the first Codex turn may also need to start its provider session.
