import type Database from "better-sqlite3";

export type ReviewState =
  | "proposed"
  | "approved"
  | "applying"
  | "applied"
  | "rejecting"
  | "rejected"
  | "superseded"
  | "failed";

export interface AppDatabase {
  sqlite: Database.Database;
  close(): void;
}

export interface ActivityEvent {
  id: string;
  workspaceId: string;
  kind: string;
  title: string;
  message: string;
  entityPath?: string;
  reviewItemId?: string;
  createdAt: string;
}

export interface ReviewItem {
  id: string;
  workspaceId: string;
  state: ReviewState;
  risk: string;
  proposalType: string;
  targetPath?: string;
  payload: unknown;
  reason: string;
  sourceSessionId: string;
  sourceTurnId: string;
  createdAt: string;
  appliedAt?: string;
  supersededBy?: string;
  failureReason?: string;
  claimToken?: string;
  claimStartedAt?: string;
  application?: unknown;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolCalls?: unknown;
  toolResult?: unknown;
  active?: boolean;
  compacted?: boolean;
  createdAt: string;
}

export interface SearchFilters {
  workspaceId?: string;
  limit?: number;
  statuses?: string[];
  excludedStatuses?: string[];
  sensitivities?: string[];
  categories?: string[];
}

export interface VectorSearchFilters {
  workspaceId?: string;
  statuses?: string[];
  excludedStatuses?: string[];
  sensitivities?: string[];
  categories?: string[];
}

export interface NoteVectorRecord {
  noteId: string;
  workspaceId: string;
  status: string;
  sensitivity: string;
  category: string;
  modelId: string;
  contentHash: string;
  embedding: number[];
}

export interface ChunkVectorRecord {
  chunkId: string;
  noteId: string;
  workspaceId: string;
  status: string;
  sensitivity: string;
  category: string;
  modelId: string;
  contentHash: string;
  embedding: number[];
}

export interface NoteVectorSearchResult {
  noteId: string;
  workspaceId: string;
  score: number;
  status: string;
  sensitivity: string;
  category: string;
}

export interface ChunkVectorSearchResult {
  chunkId: string;
  noteId: string;
  workspaceId: string;
  score: number;
  status: string;
  sensitivity: string;
  category: string;
}

export interface VectorIndex {
  upsertNotes(records: NoteVectorRecord[]): Promise<void>;
  upsertChunks(records: ChunkVectorRecord[]): Promise<void>;
  deleteNotes(noteIds: string[]): Promise<void>;
  deleteChunks(chunkIds: string[]): Promise<void>;
  searchNotes(vector: number[], filters: VectorSearchFilters, limit: number): Promise<NoteVectorSearchResult[]>;
  searchChunks(vector: number[], filters: VectorSearchFilters, limit: number): Promise<ChunkVectorSearchResult[]>;
}

export interface NoteSearchResult {
  noteId: string;
  workspaceId: string;
  path: string;
  title: string;
  summary?: string;
  snippet?: string;
  matchedFields?: string[];
}

export interface SessionSearchResult {
  messageId: string;
  sessionId: string;
  content: string;
  role: string;
}
