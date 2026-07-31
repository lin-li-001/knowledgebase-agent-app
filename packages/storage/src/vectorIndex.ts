import type Database from "better-sqlite3";
import type {
  ChunkVectorRecord,
  ChunkVectorSearchResult,
  NoteVectorRecord,
  NoteVectorSearchResult,
  VectorIndex,
  VectorSearchFilters,
} from "./types";

const VECTOR_DIMENSIONS = 1024;

export class SqliteVectorIndex implements VectorIndex {
  constructor(private readonly db: Database.Database) {}

  async upsertNotes(records: NoteVectorRecord[]): Promise<void> {
    for (const record of records) {
      assertVector(record.embedding);
      this.db.prepare("DELETE FROM note_embeddings WHERE note_id = ?").run(record.noteId);
      this.db.prepare(
        `INSERT INTO note_embeddings (
          embedding, note_id, workspace_id, status, sensitivity, category, model_id, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        vectorBuffer(record.embedding),
        record.noteId,
        record.workspaceId,
        record.status,
        record.sensitivity,
        record.category,
        record.modelId,
        record.contentHash,
      );
    }
  }

  async upsertChunks(records: ChunkVectorRecord[]): Promise<void> {
    for (const record of records) {
      assertVector(record.embedding);
      this.db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?").run(record.chunkId);
      this.db.prepare(
        `INSERT INTO chunk_embeddings (
          embedding, chunk_id, note_id, workspace_id, status, sensitivity, category, model_id, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        vectorBuffer(record.embedding),
        record.chunkId,
        record.noteId,
        record.workspaceId,
        record.status,
        record.sensitivity,
        record.category,
        record.modelId,
        record.contentHash,
      );
    }
  }

  async deleteNotes(noteIds: string[]): Promise<void> {
    if (noteIds.length === 0) return;
    const statement = this.db.prepare("DELETE FROM note_embeddings WHERE note_id = ?");
    for (const noteId of noteIds) statement.run(noteId);
  }

  async deleteChunks(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const statement = this.db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?");
    for (const chunkId of chunkIds) statement.run(chunkId);
  }

  async searchNotes(vector: number[], filters: VectorSearchFilters, limit: number): Promise<NoteVectorSearchResult[]> {
    assertVector(vector);
    const rows = this.db.prepare(
      `SELECT note_id as noteId, workspace_id as workspaceId, status, sensitivity, category, distance
       FROM note_embeddings
       WHERE embedding MATCH @embedding AND k = @candidateLimit
       ${filters.workspaceId ? "AND workspace_id = @workspaceId" : ""}`,
    ).all({
      embedding: vectorBuffer(vector),
      candidateLimit: Math.max(limit * 20, 100),
      workspaceId: filters.workspaceId,
    }) as Array<NoteVectorSearchResult & { distance: number }>;

    return rows
      .filter((row) => matchesFilters(row, filters))
      .slice(0, limit)
      .map(({ distance, ...row }) => ({ ...row, score: 1 / (1 + distance) }));
  }

  async searchChunks(vector: number[], filters: VectorSearchFilters, limit: number): Promise<ChunkVectorSearchResult[]> {
    assertVector(vector);
    const rows = this.db.prepare(
      `SELECT chunk_id as chunkId, note_id as noteId, workspace_id as workspaceId, status, sensitivity, category, distance
       FROM chunk_embeddings
       WHERE embedding MATCH @embedding AND k = @candidateLimit
       ${filters.workspaceId ? "AND workspace_id = @workspaceId" : ""}`,
    ).all({
      embedding: vectorBuffer(vector),
      candidateLimit: Math.max(limit * 20, 100),
      workspaceId: filters.workspaceId,
    }) as Array<ChunkVectorSearchResult & { distance: number }>;

    return rows
      .filter((row) => matchesFilters(row, filters))
      .slice(0, limit)
      .map(({ distance, ...row }) => ({ ...row, score: 1 / (1 + distance) }));
  }
}

function matchesFilters(
  row: { status: string; sensitivity: string; category: string },
  filters: VectorSearchFilters,
): boolean {
  return (filters.statuses === undefined || filters.statuses.includes(row.status))
    && (filters.excludedStatuses === undefined || !filters.excludedStatuses.includes(row.status))
    && (filters.sensitivities === undefined || filters.sensitivities.includes(row.sensitivity))
    && (filters.categories === undefined || filters.categories.includes(row.category));
}

function vectorBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function assertVector(vector: number[]): void {
  if (vector.length !== VECTOR_DIMENSIONS || !vector.every((value) => Number.isFinite(value))) {
    throw new Error(`Vector must contain exactly ${VECTOR_DIMENSIONS} finite dimensions`);
  }
}
