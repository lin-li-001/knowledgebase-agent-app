# Architecture

The desktop app uses Electron for the shell, React for the renderer, and reusable TypeScript packages for workspace, storage, model, and core agent behavior.

Markdown files are canonical. SQLite files are derived runtime state and must be rebuildable.
