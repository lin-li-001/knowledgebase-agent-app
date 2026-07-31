import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AppDatabase,
  ChunkVectorRecord,
  NoteVectorRecord,
  VectorIndex,
} from "@kb-agent/storage";
import { parseMarkdownNote, type ParsedMarkdownNote } from "./markdown";
import { chunkMarkdownBody, type ImportedChunk } from "./importChunks";

export interface WorkspaceEmbeddingProvider {
  modelId(): string;
  dimensions(): number;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export interface IndexWorkspaceOptions {
  embeddingProvider?: WorkspaceEmbeddingProvider;
  vectorIndex?: VectorIndex;
}

export type VectorIndexingStatus = "not_configured" | "completed" | "failed";

export interface IndexWorkspaceResult {
  workspaceId: string;
  noteCount: number;
  chunkCount: number;
  vectorIndexing: VectorIndexingStatus;
  vectorError?: string;
}

export async function indexWorkspace(
  rootPath: string,
  db: AppDatabase,
  options: IndexWorkspaceOptions = {},
): Promise<IndexWorkspaceResult> {
  const normalizedRoot = path.resolve(rootPath);
  const workspaceId = workspaceIdForRoot(normalizedRoot);
  const now = new Date().toISOString();

  db.sqlite
    .prepare(
      `INSERT INTO workspaces (id, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at`,
    )
    .run(workspaceId, normalizedRoot, now, now);

  const markdownPaths = await collectMarkdownFiles(normalizedRoot);
  const parsedNotes: ParsedMarkdownNote[] = [];
  for (const filePath of markdownPaths) {
    parsedNotes.push(await parseMarkdownNote(filePath));
  }

  const existingNoteIds = db.sqlite
    .prepare("SELECT id FROM notes WHERE workspace_id = ?")
    .all(workspaceId)
    .map((row) => (row as { id: string }).id);
  if (options.vectorIndex !== undefined) {
    await options.vectorIndex.deleteNotes(existingNoteIds);
    await options.vectorIndex.deleteChunks(existingChunkIds(db, existingNoteIds));
  }

  const projections: IndexedNoteProjection[] = [];
  db.sqlite.transaction(() => {
    clearWorkspaceIndex(db, workspaceId);
    for (const parsed of parsedNotes) {
      projections.push(insertParsedNote(db, workspaceId, normalizedRoot, parsed, now));
    }
  })();

  const chunkCount = projections.reduce((sum, projection) => sum + projection.chunks.length, 0);
  if (options.embeddingProvider === undefined || options.vectorIndex === undefined) {
    return { workspaceId, noteCount: markdownPaths.length, chunkCount, vectorIndexing: "not_configured" };
  }

  try {
    await indexVectors(projections, workspaceId, options.embeddingProvider, options.vectorIndex);
    return { workspaceId, noteCount: markdownPaths.length, chunkCount, vectorIndexing: "completed" };
  } catch (error) {
    return {
      workspaceId,
      noteCount: markdownPaths.length,
      chunkCount,
      vectorIndexing: "failed",
      vectorError: error instanceof Error ? error.message : "Vector indexing failed",
    };
  }
}

function clearWorkspaceIndex(db: AppDatabase, workspaceId: string): void {
  const noteIds = db.sqlite
    .prepare("SELECT id FROM notes WHERE workspace_id = ?")
    .all(workspaceId)
    .map((row) => (row as { id: string }).id);

  for (const noteId of noteIds) {
    db.sqlite.prepare("DELETE FROM note_fts WHERE note_id = ?").run(noteId);
    db.sqlite.prepare("DELETE FROM note_fts_trigram WHERE note_id = ?").run(noteId);
  }

  db.sqlite.prepare("DELETE FROM notes WHERE workspace_id = ?").run(workspaceId);
}

async function collectMarkdownFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }

      files.push(...(await collectMarkdownFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md") {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function shouldSkipDirectory(name: string): boolean {
  return name === ".app" || name === "06-Attachments" || name === "node_modules" || name.startsWith(".");
}

function insertParsedNote(
  db: AppDatabase,
  workspaceId: string,
  rootPath: string,
  note: ParsedMarkdownNote,
  now: string,
): IndexedNoteProjection {
  const relativePath = path.relative(rootPath, note.path);
  const summary = note.frontmatter.summary ?? firstMeaningfulParagraph(note.body);
  const noteId = createHash("sha256").update(`${workspaceId}:${relativePath}`).digest("hex");

  db.sqlite
    .prepare(
      `INSERT INTO notes (
        id, workspace_id, path, title, type, status, owner, scope, sensitivity,
        content_category, tags_json, summary, summary_source, content_hash, modified_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      noteId,
      workspaceId,
      relativePath,
      note.frontmatter.title,
      note.frontmatter.type,
      note.frontmatter.status,
      note.frontmatter.owner,
      note.frontmatter.scope,
      note.frontmatter.sensitivity,
      note.frontmatter.content_category ?? "unknown",
      JSON.stringify(note.frontmatter.tags),
      summary,
      note.frontmatter.summary ? "frontmatter" : "heuristic",
      note.contentHash,
      now,
      now,
    );

  const headings = note.headings.join("\n");
  db.sqlite
    .prepare("INSERT INTO note_fts (note_id, workspace_id, title, summary, headings, body, path) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(noteId, workspaceId, note.frontmatter.title, summary, headings, note.body, relativePath);
  db.sqlite
    .prepare("INSERT INTO note_fts_trigram (note_id, workspace_id, title, summary, headings, body, path) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(noteId, workspaceId, note.frontmatter.title, summary, headings, note.body, relativePath);

  const chunks = chunkMarkdownBody(note.body, { noteId });
  insertChunks(db, relativePath, chunks);
  return { noteId, note, chunks };
}

function insertChunks(db: AppDatabase, relativePath: string, chunks: ImportedChunk[]): void {
  const insert = db.sqlite.prepare(
    `INSERT INTO chunks (
      id, note_id, path, heading_path, text, start_line, end_line, token_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const chunk of chunks) {
    insert.run(
      chunk.id,
      chunk.noteId,
      relativePath,
      JSON.stringify(chunk.headingPath),
      chunk.text,
      chunk.startLine,
      chunk.endLine,
      chunk.tokenCount,
    );
  }
}

interface IndexedNoteProjection {
  noteId: string;
  note: ParsedMarkdownNote;
  chunks: ImportedChunk[];
}

function existingChunkIds(db: AppDatabase, noteIds: string[]): string[] {
  if (noteIds.length === 0) return [];
  const placeholders = noteIds.map(() => "?").join(", ");
  return db.sqlite
    .prepare(`SELECT id FROM chunks WHERE note_id IN (${placeholders})`)
    .all(...noteIds)
    .map((row) => (row as { id: string }).id);
}

async function indexVectors(
  projections: IndexedNoteProjection[],
  workspaceId: string,
  embeddingProvider: WorkspaceEmbeddingProvider,
  vectorIndex: VectorIndex,
): Promise<void> {
  if (embeddingProvider.dimensions() !== 1024) {
    throw new Error("Local vector index requires 1024-dimensional embeddings");
  }
  const noteInputs = projections.map((projection) => noteEmbeddingInput(projection.note));
  const chunkInputs = projections.flatMap((projection) => projection.chunks.map((chunk) => chunkEmbeddingInput(projection.note, chunk)));
  const [noteEmbeddings, chunkEmbeddings] = await Promise.all([
    embeddingProvider.embedDocuments(noteInputs),
    embeddingProvider.embedDocuments(chunkInputs.map((input) => input.text)),
  ]);
  if (noteEmbeddings.length !== projections.length || chunkEmbeddings.length !== chunkInputs.length) {
    throw new Error("Embedding provider returned an unexpected batch size");
  }

  const noteRecords: NoteVectorRecord[] = projections.map((projection, index) => ({
    noteId: projection.noteId,
    workspaceId,
    status: projection.note.frontmatter.status,
    sensitivity: projection.note.frontmatter.sensitivity,
    category: projection.note.frontmatter.content_category ?? "unknown",
    modelId: embeddingProvider.modelId(),
    contentHash: projection.note.contentHash,
    embedding: noteEmbeddings[index]!,
  }));
  const chunkRecords: ChunkVectorRecord[] = chunkInputs.map((input, index) => ({
    ...input,
    workspaceId,
    status: input.note.frontmatter.status,
    sensitivity: input.note.frontmatter.sensitivity,
    category: input.note.frontmatter.content_category ?? "unknown",
    modelId: embeddingProvider.modelId(),
    contentHash: input.note.contentHash,
    embedding: chunkEmbeddings[index]!,
  }));
  await vectorIndex.upsertNotes(noteRecords);
  await vectorIndex.upsertChunks(chunkRecords);
}

function noteEmbeddingInput(note: ParsedMarkdownNote): string {
  return [
    note.frontmatter.title,
    note.frontmatter.summary ?? "",
    note.frontmatter.content_category ?? "unknown",
    note.frontmatter.tags.join(" "),
  ].filter(Boolean).join("\n");
}

function chunkEmbeddingInput(note: ParsedMarkdownNote, chunk: ImportedChunk): { note: ParsedMarkdownNote; chunkId: string; noteId: string; text: string } {
  return {
    note,
    chunkId: chunk.id,
    noteId: chunk.noteId,
    text: [note.frontmatter.title, chunk.headingPath.join(" > "), chunk.text].filter(Boolean).join("\n"),
  };
}

function firstMeaningfulParagraph(body: string): string {
  return (
    body
      .split(/\n\s*\n/u)
      .map((paragraph) => paragraph.replace(/^#{1,6}\s+/u, "").trim())
      .find(Boolean) ?? ""
  );
}

export function workspaceIdForRoot(rootPath: string): string {
  return createHash("sha256").update(path.resolve(rootPath)).digest("hex");
}
