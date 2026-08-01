# Architecture

The desktop app uses Electron for the shell, React for the renderer, and reusable TypeScript packages for workspace, storage, model, and core agent behavior.

Markdown files are canonical. SQLite files are derived runtime state and must be rebuildable.

Workspace indexing parses Markdown frontmatter and body into SQLite `notes` and `chunks`, then derives FTS5 and sqlite-vec indexes. The indexer compares the stable note path ID and full-file content hash so unchanged notes do not receive duplicate embeddings. A desktop workspace watcher debounces Markdown changes and invokes the same incremental indexer; runtime, staging, and attachment paths are excluded.

Chat retrieval uses a local hybrid provider. It embeds the query, searches note and chunk vectors, searches note FTS, and combines ranked results with Reciprocal Rank Fusion. Note-level lexical and semantic signals contribute to matching source chunks, which retain their Markdown path, heading, and line provenance.

PDF extraction first uses the verified source buffer with the PDF parser. When local Poppler `pdftotext` is available, its layout-preserving output is preferred; otherwise the parser output remains the fallback. Image-only PDFs can use local `pdftoppm` and `tesseract` when installed and are marked `requires_ocr` when the OCR runtime is unavailable.
