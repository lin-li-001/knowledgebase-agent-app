# IPC Contract

Renderer code may call only the v0.1A channels listed in `apps/desktop/electron/ipc.ts`.

The preload script exposes `window.kbAgent.invoke(channel, input)` and does not expose `ipcRenderer`, filesystem APIs, shell APIs, or raw path authority.

All inputs are validated in the main process with zod. Handler errors are returned as `{ ok: false, error: string }` without stack traces.

Reserved v0.1B channels:

- `import:start`
- `import:get-job`
- `review-worker:run`
