# Local Semantic Import and Retrieval Design

## Status

Approved design for implementation.

## Goal

Make imported Markdown the source of truth while adding local semantic enrichment and retrieval. Every imported source produces one authoritative Markdown note. The app derives SQLite metadata/chunk indexes and a rebuildable vector index from that note.

## Source of truth and derived indexes

Markdown remains the durable artifact. Its frontmatter contains user-visible import results such as `summary`, `content_category`, `sensitivity`, classification confidence/evidence, review decision, status, source link, and destination.

SQLite is a rebuildable application index:

- `notes` stores document-level metadata, path, content hash, and lifecycle fields.
- `chunks` stores source-faithful body segments with note identity, heading path, line/page location, and token counts.
- Existing duplicated note-level FTS tables are not the semantic source. The implementation may retain one lexical fallback during migration, but `note_fts_trigram` is not part of the target retrieval design.

The vector index is also rebuildable. It stores embeddings and stable IDs/metadata that point back to `notes` and `chunks`; it does not replace Markdown or SQLite metadata.

## Import pipeline

1. Extract the PDF into source-faithful Markdown body text, preserving page markers and OCR state.
2. Create internal base metadata from the source file: title, source attachment link, owner, scope, and creation date.
3. Split the extracted body into bounded, heading-aware chunks while retaining page and line provenance.
4. Run semantic enrichment over the whole document through chunk-level analysis followed by document-level aggregation. Produce a concise summary, primary/alternative categories, sensitivity, confidence, and evidence.
5. Merge semantic signals with deterministic detectors and saved user routing policy using the established precedence. User overrides remain highest priority; the Safety Kernel remains the final safety authority.
6. Render one final Markdown note. Semantic enrichment results that are useful to a person or audit are written to frontmatter. Embedding arrays, model internals, and intermediate reasoning are not written to Markdown.
7. Write the note to staging or promote it according to the Safety Kernel decision. Re-index only accepted final notes; staged imports remain excluded from normal search.

The implementation should avoid writing a misleading heuristic summary before semantic enrichment. A provisional internal object may exist during processing, but the user-visible Markdown frontmatter is rendered after enrichment and safety classification.

## Embeddings

The first local embedding model is `BAAI/bge-m3`, behind an interchangeable provider interface. It is selected for mixed Chinese/English content, long passages, and the option to add hybrid retrieval later. The provider records model ID and vector dimensions so changing models invalidates and rebuilds stale vectors.

The provider contract is conceptually:

```ts
interface EmbeddingProvider {
  modelId(): string;
  dimensions(): number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
```

The initial integration must support a local execution adapter without coupling import code or retrieval code to one runtime. The vector store must support local persistence, metadata filtering, deletion/upsert by stable ID, and rebuild from SQLite/Markdown.

## Vector records

Create two logical vector collections/tables:

- Note vectors: embedding of title, summary, category, and tags; metadata includes `note_id`, path, status, sensitivity, and category.
- Chunk vectors: embedding of chunk text plus heading context; metadata includes `chunk_id`, `note_id`, path, heading path, page/line location, content hash, and status/sensitivity inherited from the note.

The embedding input is derived from the current Markdown/SQLite projection. `content_hash` and `embedding_model` identify stale records. Re-indexing must be idempotent.

## Query and retrieval flow

1. Embed the user question with the same model used for document vectors.
2. Search note vectors for document-level candidates.
3. Search chunk vectors globally for direct answer-level candidates.
4. Apply workspace and safety filters; by default, exclude blocked, rejected, and pending-review artifacts from normal answer context. Category and sensitivity filters are explicit retrieval constraints rather than hidden assumptions.
5. Merge note and chunk candidates, deduplicate by `note_id`/`chunk_id`, and aggregate evidence by note.
6. Rerank the candidate chunks using a replaceable reranker interface. Keep the source path and page/line provenance.
7. Pass the top source chunks, not only summaries, into the model context.

The current lexical search can remain as a fallback during rollout for exact names, dates, amounts, and identifiers. The target design removes the need for two duplicated full-body FTS tokenizers; any lexical fallback should be one explicit retrieval channel fused with vector results.

## Safety and frontmatter

Semantic enrichment proposes meaning; it does not authorize writes. The existing precedence remains:

```text
current Review override
> saved user routing policy
> deterministic detector
> semantic classifier
> default routing policy
> Inbox fallback
```

The Safety Kernel still enforces path, collision, confidence, sensitivity, protected category, and review rules. Final frontmatter records the resulting classification and safety state, including:

- `summary`
- `content_category`
- `sensitivity`
- `classification_confidence`
- `classification_evidence`
- `review_decision`
- `safety_reason_codes`
- `status`
- `route_destination`

Embedding operational metadata belongs in the SQLite/vector index, not in the note frontmatter.

## Failure handling

- If extraction fails, preserve the original attachment and leave a blocked/staged artifact with a clear reason.
- If semantic enrichment fails or returns invalid data, use no invented summary/category; route to Review or Inbox according to the Safety Kernel.
- If embedding fails, keep the accepted Markdown and SQLite projection usable. Mark vector indexing incomplete and allow a rebuild/retry.
- If the embedding model or dimensions change, invalidate only affected vectors and rebuild them from current Markdown/SQLite data.

## Verification

Tests must cover:

- deterministic chunk boundaries and source provenance;
- semantic enrichment validation and invalid-output fallback;
- frontmatter contains enrichment results exactly once;
- note/chunk vector upsert, deletion, stale-hash detection, and rebuild;
- query embedding and merged note/chunk retrieval;
- safety filters exclude staged/blocked/rejected notes;
- source paths and page/line citations survive reranking;
- existing import, Review, routing, and full QA suites remain green.

