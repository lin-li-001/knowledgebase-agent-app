import type {
  AppDatabase,
  NoteSearchResult,
  SearchFilters,
  SessionSearchResult,
} from "./types";

export async function searchNotes(
  db: AppDatabase,
  query: string,
  filters: SearchFilters = {},
): Promise<NoteSearchResult[]> {
  const limit = filters.limit ?? 20;
  const isCjkQuery = containsCjk(query);
  const normalizedQuery = toFtsQuery(query);
  if (!isCjkQuery && !normalizedQuery) {
    return [];
  }
  const table = isCjkQuery ? "note_fts_trigram" : "note_fts";
  const workspaceClause = filters.workspaceId ? "AND f.workspace_id = @workspaceId" : "";
  const matchExpression = isCjkQuery
    ? "(f.title LIKE @likeQuery OR f.summary LIKE @likeQuery OR f.headings LIKE @likeQuery OR f.body LIKE @likeQuery)"
    : `${table} MATCH @query`;

  return db.sqlite
    .prepare(
      `SELECT
        f.note_id as noteId,
        f.workspace_id as workspaceId,
        f.path,
        f.title,
        f.summary
      FROM ${table} f
      WHERE ${matchExpression} ${workspaceClause}
      LIMIT @limit`,
    )
    .all({
      query: normalizedQuery,
      likeQuery: `%${query.trim()}%`,
      workspaceId: filters.workspaceId,
      limit,
    }) as NoteSearchResult[];
}

export async function searchSessions(
  db: AppDatabase,
  query: string,
  filters: SearchFilters = {},
): Promise<SessionSearchResult[]> {
  const limit = filters.limit ?? 20;
  const isCjkQuery = containsCjk(query);
  const normalizedQuery = toFtsQuery(query);
  if (!isCjkQuery && !normalizedQuery) {
    return [];
  }
  const table = isCjkQuery ? "message_fts_trigram" : "message_fts";
  const sessionClause = filters.workspaceId
    ? "AND f.session_id IN (SELECT id FROM sessions WHERE workspace_id = @workspaceId)"
    : "";
  const matchExpression = isCjkQuery
    ? "(f.content LIKE @likeQuery OR f.role LIKE @likeQuery)"
    : `${table} MATCH @query`;

  return db.sqlite
    .prepare(
      `SELECT
        f.message_id as messageId,
        f.session_id as sessionId,
        f.content,
        f.role
      FROM ${table} f
      WHERE ${matchExpression} ${sessionClause}
      LIMIT @limit`,
    )
    .all({
      query: normalizedQuery,
      likeQuery: `%${query.trim()}%`,
      workspaceId: filters.workspaceId,
      limit,
    }) as SessionSearchResult[];
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function toFtsQuery(value: string): string {
  return value
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.join(" ") ?? "";
}
