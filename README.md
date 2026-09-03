# LanternLM™

**Private, portable AI that runs entirely on your computer.**

LanternLM is a Windows desktop client for chatting with local GGUF language
models through llama.cpp. It was built as an offline-first alternative to
cloud AI clients: prompts, responses, files, and conversation history remain
on the user's machine.

> Status: portfolio release. The source is ready for review; llama.cpp runtime
> binaries and model weights are installed separately.

## Highlights

- Runs GGUF language models locally without an internet connection
- Streams generated text from a local llama.cpp server
- Persists conversations in a local SQLite database
- Discovers multiple models and lets the user select one
- Includes a portable file workspace with text, image, and PDF previews
- Keeps Electron renderer access behind a context-isolated preload API
- Packages as a Windows desktop application with Electron Builder

## Architecture

```text
React + TypeScript renderer
          │
          ├── local HTTP stream ──> llama.cpp server ──> GGUF model
          │
          └── Electron preload ──> IPC handlers ──> SQLite + local files
```

The Electron main process starts `llama-server.exe` on `127.0.0.1:4891` and
manages application data under `portable/`. The renderer streams completions
from the local OpenAI-compatible endpoint. Conversations are stored in SQLite;
no telemetry or cloud API is used by LanternLM.

## Technology

- Electron
- React 19 and TypeScript
- Vite
- llama.cpp
- better-sqlite3
- Electron Builder

## Prerequisites

- Windows 10 or newer
- Node.js 20 or newer
- A Windows llama.cpp release containing `llama-server.exe`
- At least one compatible `.gguf` instruct model
- Enough RAM for the selected model and context size

Model weights and llama.cpp binaries are deliberately not committed. They are
large third-party artifacts with independent licenses.

## Local setup

1. Clone the repository and run `npm install`.
2. Copy `llama-server.exe` and the DLL files from the same llama.cpp release
   into `portable/bin/`.
3. Copy a compatible `.gguf` model into `portable/models/`.
4. Run `npm run dev`.
5. Select the model in LanternLM and choose **Load model**.

## Quality checks

```powershell
npm run lint
npm run typecheck
npm run build
```

Run all checks together with `npm run check`.

## Build a Windows installer

Run `npm run dist`. The installer is written to `release/`. Runtime binaries
may be included in a private or release build, but model weights should
normally be distributed separately. Review all third-party licenses before
publishing a binary package.

## Repository hygiene

The Git configuration excludes model weights, llama.cpp binaries, installers,
compiled output, SQLite databases, chat history, exports, and workspace files.
Never force-add those files without reviewing their size, privacy, and license.

## Privacy and limitations

- LanternLM itself makes no cloud requests, but users are responsible for the
  origin and behavior of separately obtained models and runtime binaries.
- Generated text can be inaccurate.
- Performance depends on model size and host hardware.
- The current release targets Windows and CPU-based llama.cpp distributions.

## License and attribution

Copyright © 2026 Faheem Shah Umer Vattam Kandathil. The source is available under the [MIT License](LICENSE).

LanternLM™ is an unregistered project mark used by Faheem Shah Umer Vattam Kandathil. See [NOTICE.md](NOTICE.md)
and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution details.
