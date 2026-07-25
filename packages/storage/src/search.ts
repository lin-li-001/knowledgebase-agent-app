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
  const recallTokens = toRecallTokens(query);
  const normalizedQuery = toRecallFtsQuery(query, recallTokens);
  if (!isCjkQuery && !normalizedQuery) {
    return [];
  }
  const table = isCjkQuery ? "note_fts_trigram" : "note_fts";
  const workspaceClause = filters.workspaceId ? "AND f.workspace_id = @workspaceId" : "";
  const matchExpression = isCjkQuery
    ? "(f.title LIKE @likeQuery OR f.summary LIKE @likeQuery OR f.headings LIKE @likeQuery OR f.body LIKE @likeQuery)"
    : `${table} MATCH @query`;

  const rows = db.sqlite
    .prepare(
      `SELECT
        f.note_id as noteId,
        f.workspace_id as workspaceId,
        f.path,
        f.title,
        f.summary,
        f.headings,
        f.body,
        snippet(${table}, 5, '', '', '...', 18) as snippet
      FROM ${table} f
      WHERE ${matchExpression} ${workspaceClause}
      LIMIT @limit`,
    )
    .all({
      query: normalizedQuery,
      likeQuery: `%${query.trim()}%`,
      workspaceId: filters.workspaceId,
      limit,
    }) as NoteSearchRow[];

  return rows.map((row) => {
    const result: NoteSearchResult = {
      noteId: row.noteId,
      workspaceId: row.workspaceId,
      path: row.path,
      title: row.title,
    };
    const snippet = normalizeSnippet(row.snippet || row.summary || row.body);
    const fields = matchedFields(row, recallTokens);
    if (row.summary) {
      result.summary = row.summary;
    }
    if (snippet) {
      result.snippet = snippet;
    }
    if (fields.length) {
      result.matchedFields = fields;
    }
    return result;
  });
}

interface NoteSearchRow extends NoteSearchResult {
  headings?: string;
  body?: string;
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

const ftsStopwords = new Set([
  "a",
  "about",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "during",
  "for",
  "from",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "there",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

function toRecallTokens(value: string): string[] {
  return expandRecallTokens(value)
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.filter((token) => token.length > 1 && !ftsStopwords.has(token)) ?? [];
}

function toRecallFtsQuery(value: string, tokens = toRecallTokens(value)): string {
  if (tokens.length === 0) {
    return toFtsQuery(value);
  }

  return [...new Set(tokens)].map((token) => `"${token.replace(/"/gu, "\"\"")}"`).join(" OR ");
}

function expandRecallTokens(value: string): string {
  const lower = value.toLocaleLowerCase();
  const years = lower.match(/\b(?:19|20)\d{2}\b/gu)?.map(Number) ?? [];
  const asksAboutWork =
    /\b(work|worked|job|company|employer|employment|career|resume|experience)\b/u.test(lower);

  if (!asksAboutWork || years.length === 0) {
    return value;
  }

  const nearbyYears = years.flatMap((year) => [year - 1, year, year + 1]);
  return [
    value,
    "work worked job company employer employment career resume experience",
    ...nearbyYears.map(String),
  ].join(" ");
}

function normalizeSnippet(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function matchedFields(row: NoteSearchRow, tokens: string[]): string[] {
  const fields = [
    ["title", row.title],
    ["summary", row.summary],
    ["headings", row.headings],
    ["body", row.body],
  ] as const;
  const uniqueTokens = [...new Set(tokens.map((token) => token.toLocaleLowerCase()))];

  return fields
    .filter(([, value]) => {
      const lower = (value ?? "").toLocaleLowerCase();
      return uniqueTokens.some((token) => lower.includes(token));
    })
    .map(([field]) => field);
}
