# Local Semantic Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add source-first semantic import enrichment and local notes/chunks vector retrieval while keeping Markdown as the durable source of truth.

**Architecture:** Import extracts source-faithful Markdown, chunks the body, calls a semantic enrichment boundary, merges model/detector/policy signals through the existing Safety Kernel, and renders final frontmatter once. Workspace indexing derives SQLite `notes` and `chunks`, then generates note/chunk embeddings through a local provider and stores them in a rebuildable local vector index. Chat retrieves note and chunk candidates, applies safety filters, reranks, and passes source chunks to the model.

**Tech Stack:** TypeScript monorepo, Electron/Vite desktop app, `better-sqlite3`, SQLite migrations, `sqlite-vec` local extension, existing `ModelProvider`, local Ollama-compatible embedding adapter using `BAAI/bge-m3`, Vitest, Playwright.

## Global Constraints

- Markdown is the only durable source of truth; SQLite and vector records are rebuildable projections.
- Semantic enrichment is complete before the user-visible final frontmatter is rendered.
- `BAAI/bge-m3` is the default embedding model behind an interchangeable provider interface.
- Staged, blocked, rejected, and pending-review imports do not enter normal answer context.
- User routing overrides remain higher priority than saved policy, detectors, and semantic model signals.
- Embedding arrays, prompts, and intermediate model reasoning do not enter Markdown frontmatter.
- Existing import, Review, routing, and product-audit behavior must remain covered.

---

### Task 1: Define semantic and chunk data contracts

**Files:**
- Create: `packages/workspace/src/importChunks.ts`
- Create: `packages/workspace/src/importSemanticEnrichment.ts`
- Modify: `packages/workspace/src/imports.ts`
- Modify: `packages/workspace/src/importSafety.ts`
- Modify: `packages/workspace/src/index.ts`
- Test: `packages/workspace/tests/importChunks.test.ts`
- Test: `packages/workspace/tests/importSemanticEnrichment.test.ts`

**Interfaces:**
- `chunkMarkdownBody(body: string): ImportedChunk[]`
- `SemanticImportEnricher.enrich(input: SemanticImportInput): Promise<SemanticImportResult>`
- `SemanticImportResult.summary`, `primaryCategory`, `alternativeCategories`, `sensitivity`, `confidence`, and `evidence`
- `ImportBatchInput.semanticEnricher?: SemanticImportEnricher`

- [ ] **Step 1: Write failing chunk tests** for heading boundaries, bounded body size, page-marker provenance, line ranges, stable IDs, and empty/OCR bodies.
- [ ] **Step 2: Run `pnpm --filter @kb-agent/workspace test -- importChunks.test.ts`** and verify the new tests fail because the chunker does not exist.
- [ ] **Step 3: Implement heading-aware bounded chunking** that carries the nearest heading, page marker, start/end lines, token count, and a deterministic ID derived from note identity plus chunk position.
- [ ] **Step 4: Write failing semantic contract tests** for valid output normalization, missing summary, invalid category/sensitivity, and enrichment failure behavior.
- [ ] **Step 5: Implement schema validation and safe normalization**. The contract must return no invented semantic fields on invalid output and expose a failure reason to the importer.
- [ ] **Step 6: Run the focused workspace tests and typecheck.**
- [ ] **Step 7: Commit** with `git add packages/workspace && git commit -m "feat: add import chunk and enrichment contracts"`.

### Task 2: Run semantic enrichment before final frontmatter rendering

**Files:**
- Modify: `packages/workspace/src/imports.ts`
- Modify: `packages/workspace/src/importClassification.ts`
- Modify: `packages/workspace/src/frontmatter.ts`
- Modify: `packages/workspace/tests/imports.test.ts`
- Modify: `packages/workspace/tests/importClassification.test.ts`

**Interfaces:**
- `routeDocument()` consumes an optional semantic result and emits a model classification signal.
- `renderImportedSourceNote()` consumes the final summary and merged classification.

- [ ] **Step 1: Add failing import tests** asserting that a supplied semantic enricher summary is written to frontmatter, the body remains source-faithful, and no heuristic first-paragraph summary replaces it.
- [ ] **Step 2: Add failing tests** asserting that semantic category/sensitivity/confidence/evidence become model signals and that user policy/detector precedence still wins according to the established priority.
- [ ] **Step 3: Implement the import sequence**: extract body, chunk internally, call semantic enrichment, merge signals, evaluate Safety Kernel, and render final frontmatter once.
- [ ] **Step 4: Implement explicit fallback behavior**: if enrichment is unavailable or invalid, preserve the source body, use detector/policy signals only, mark the classification as requiring Review when confidence is insufficient, and never fabricate a summary.
- [ ] **Step 5: Add the final frontmatter fields** `summary`, `content_category`, `sensitivity`, `classification_confidence`, and `classification_evidence` from the merged result; keep embedding metadata out of the note.
- [ ] **Step 6: Run import, classification, safety, promotion, and audit tests.**
- [ ] **Step 7: Commit** with `git add packages/workspace && git commit -m "feat: enrich imports before rendering frontmatter"`.

### Task 3: Add local embedding provider and vector schema

**Files:**
- Create: `packages/model/src/embedding.ts`
- Create: `packages/model/src/ollamaEmbeddingProvider.ts`
- Modify: `packages/model/src/index.ts`
- Modify: `packages/model/package.json`
- Modify: `packages/storage/src/schema.ts`
- Modify: `packages/storage/src/migrations.ts`
- Modify: `packages/storage/src/types.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/model/tests/embedding.test.ts`
- Test: `packages/storage/tests/vectorIndex.test.ts`

**Interfaces:**
- `EmbeddingProvider.modelId(): string`
- `EmbeddingProvider.dimensions(): number`
- `EmbeddingProvider.embedDocuments(texts: string[]): Promise<number[][]>`
- `EmbeddingProvider.embedQuery(text: string): Promise<number[]>`
- `VectorIndex.upsertNotes(records: NoteVectorRecord[]): Promise<void>`
- `VectorIndex.upsertChunks(records: ChunkVectorRecord[]): Promise<void>`
- `VectorIndex.searchNotes(vector, filters, limit)` and `searchChunks(vector, filters, limit)`

- [ ] **Step 1: Write provider contract tests** using a fake fetch response for the local Ollama-compatible `/api/embed` endpoint, including dimension mismatch and HTTP error cases.
- [ ] **Step 2: Add `EmbeddingProvider` and implement `OllamaEmbeddingProvider`** with default model `bge-m3`, configurable base URL, batch document embedding, and query embedding.
- [ ] **Step 3: Add storage migration tests** for vector metadata, model ID, dimensions, content hashes, stable note/chunk IDs, and deletion/upsert behavior.
- [ ] **Step 4: Add `sqlite-vec` and implement the local vector index** with separate note and chunk vector collections/tables plus metadata joins to SQLite `notes` and `chunks`.
- [ ] **Step 5: Make vector writes idempotent** and ensure old vectors are deleted when notes/chunks disappear or content hashes change.
- [ ] **Step 6: Run model/storage focused tests and typecheck.**
- [ ] **Step 7: Commit** with `git add packages/model packages/storage && git commit -m "feat: add local embedding and vector index"`.

### Task 4: Replace whole-document chunks with indexed source chunks

**Files:**
- Modify: `packages/workspace/src/indexer.ts`
- Modify: `packages/storage/src/schema.ts`
- Modify: `packages/storage/src/types.ts`
- Modify: `packages/workspace/tests/indexer.test.ts`
- Modify: `packages/storage/tests/storage.test.ts`

**Interfaces:**
- `indexWorkspace(rootPath, db, options?: { embeddingProvider?: EmbeddingProvider; vectorIndex?: VectorIndex })`
- `IndexWorkspaceResult` includes `chunkCount` and vector indexing state.

- [ ] **Step 1: Update indexer tests** to expect multiple chunks for a multi-heading note, exact source line/page provenance, and excluded staging/attachment files.
- [ ] **Step 2: Implement chunk projection** from parsed Markdown into SQLite `chunks`, replacing the current one-chunk-per-note behavior.
- [ ] **Step 3: Generate note embedding input** from title, summary, category, and tags; generate chunk embedding input from heading context plus chunk body.
- [ ] **Step 4: Upsert vector records after the SQLite projection commits**, preserving Markdown/SQLite usability if embedding fails and returning a retryable indexing status.
- [ ] **Step 5: Run workspace/storage indexer tests, including rebuild and stale-hash cases.**
- [ ] **Step 6: Commit** with `git add packages/workspace packages/storage && git commit -m "feat: index source chunks and embeddings"`.

### Task 5: Implement semantic notes/chunks retrieval and filters

**Files:**
- Create: `packages/storage/src/vectorSearch.ts`
- Modify: `packages/storage/src/search.ts`
- Modify: `packages/storage/src/types.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/core/src/orchestrator/reranker.ts`
- Modify: `packages/core/src/orchestrator/recallProvider.ts`
- Modify: `packages/core/src/orchestrator/contextBuilder.ts`
- Test: `packages/storage/tests/vectorSearch.test.ts`
- Test: `packages/core/tests/contextBuilder.test.ts`
- Test: `packages/core/tests/recallProvider.test.ts`

**Interfaces:**
- `SearchFilters` gains explicit `statuses`, `sensitivities`, and `categories` filters.
- `SemanticRecallProvider.prefetch()` returns source chunks with note metadata and provenance.
- `Reranker.rerank(query, candidates)` returns ordered candidates with scores.

- [ ] **Step 1: Write failing vector search tests** for note-level retrieval, chunk-level retrieval, metadata filters, workspace isolation, and exclusion of pending/blocked/rejected artifacts by default.
- [ ] **Step 2: Implement note/chunk vector search** and merge results by `note_id`/`chunk_id`.
- [ ] **Step 3: Add the existing lexical search as one explicit fallback channel** for exact names, dates, amounts, and identifiers; stop making `note_fts_trigram` the primary CJK path.
- [ ] **Step 4: Implement deterministic score fusion and a replaceable reranker boundary.** The first reranker must preserve vector and lexical scores and use source provenance as a tie-breaker; a model reranker can be added without changing recall contracts.
- [ ] **Step 5: Make the recall provider embed the user query, search notes and chunks in parallel, aggregate candidates, rerank, and return the top source chunks rather than only summaries/snippets.
- [ ] **Step 6: Update context-builder tests** to verify source body text, path, heading, and page/line provenance are passed to the model context.
- [ ] **Step 7: Run storage/core focused tests.**
- [ ] **Step 8: Commit** with `git add packages/storage packages/core && git commit -m "feat: retrieve semantic source chunks"`.

### Task 6: Wire semantic enrichment and local retrieval into the desktop app

**Files:**
- Modify: `packages/core/src/imports/importService.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/ipc.ts`
- Modify: `apps/desktop/tests/ui.test.tsx`
- Modify: `docs/ipc-contract.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Desktop import creates the semantic enricher from the existing model provider and passes it into `startImportBatch`.
- Desktop workspace startup creates the local embedding provider/vector index and passes them into indexing and recall.

- [ ] **Step 1: Add UI/service tests** for import status when enrichment is unavailable, accepted source notes, pending Review notes, and vector indexing retry state.
- [ ] **Step 2: Wire the existing model provider into semantic import enrichment** with strict JSON parsing and the Safety Kernel fallback path.
- [ ] **Step 3: Wire the local embedding provider and vector index** into workspace open/import rebuild flows without changing Markdown paths.
- [ ] **Step 4: Update IPC contracts and settings defaults** for local embedding endpoint/model and index status.
- [ ] **Step 5: Run desktop unit tests and E2E tests.**
- [ ] **Step 6: Commit** with `git add apps packages/core docs && git commit -m "feat: wire local semantic import and retrieval"`.

### Task 7: Full verification and migration cleanup

**Files:**
- Modify: `packages/storage/src/schema.ts` if migration cleanup is required
- Modify: `packages/workspace/src/productAudit.ts`
- Modify: `packages/workspace/src/workspaceAudit.ts`
- Modify: relevant tests and `docs/architecture.md`

- [ ] **Step 1: Add product-audit assertions** for final frontmatter enrichment, source-faithful body, chunk/vector rebuildability, and review filtering.
- [ ] **Step 2: Add a migration/rebuild test** that starts with Markdown only, rebuilds SQLite and vectors, edits one note, and verifies only affected records change.
- [ ] **Step 3: Run `pnpm typecheck`.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Run `pnpm --filter @kb-agent/desktop test:e2e`.**
- [ ] **Step 6: Run `pnpm qa` with the repository's better-sqlite3 rebuild gate.**
- [ ] **Step 7: Review the diff, confirm no staged artifacts enter search, and commit** with `git commit -m "test: verify local semantic retrieval flow"`.

