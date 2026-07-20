import type Database from "better-sqlite3";

export type ReviewState = "proposed" | "approved" | "applied" | "rejected" | "superseded" | "failed";

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
}

export interface NoteSearchResult {
  noteId: string;
  workspaceId: string;
  path: string;
  title: string;
  summary?: string;
}

export interface SessionSearchResult {
  messageId: string;
  sessionId: string;
  content: string;
  role: string;
}
