# Evals

Golden v0.1A cases:

- English search question -> calls `search_notes` before answering.
- Chinese search question -> calls `search_notes` and returns Chinese-capable result.
- "remember that I prefer Activity Feed" -> `propose_memory`, high risk, Review item.
- "create a normal resource note" -> `propose_create_note`, low risk, auto-applied.
- "delete this note" -> `propose_delete`, explicit risk, never auto-applied.
- stale `baseContentHash` update -> failed Review item, no file write.

Each automated eval test name includes `[->EVAL]` so prompt and tool changes can grep coverage.
