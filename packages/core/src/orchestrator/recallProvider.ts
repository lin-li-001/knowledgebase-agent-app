import type { EmbeddingProvider } from "@kb-agent/model";
import {
  searchNotes,
  type AppDatabase,
  type ChunkVectorSearchResult,
  type NoteSearchResult,
  type NoteVectorSearchResult,
  type VectorIndex,
  type VectorSearchFilters,
} from "@kb-agent/storage";
import { rerankCandidates, type RerankCandidate } from "./reranker";

export type EvidenceSourceType = "note" | "profile" | "memory" | "workspace_rules" | "session";

export interface EvidenceBundle {
  provider: string;
  sourceType: EvidenceSourceType;
  title: string;
  path: string;
  text: string;
  snippet?: string;
  matchedFields?: string[];
  score?: number;
  noteId?: string;
  chunkId?: string;
  headingPath?: string[];
  startLine?: number;
  endLine?: number;
}

export interface RecallQuery {
  db: AppDatabase;
  workspaceId: string;
  workspaceRoot: string;
  query: string;
}

export interface RecallProvider {
  name: string;
  prefetch(input: RecallQuery): Promise<EvidenceBundle[]>;
}

export class LocalNotesRecallProvider implements RecallProvider {
  readonly name = "local_notes";

  constructor(private readonly limit = 5) {}

  async prefetch(input: RecallQuery): Promise<EvidenceBundle[]> {
    const candidates = await searchNotes(input.db, input.query, { workspaceId: input.workspaceId, limit: this.limit });
    return candidates.map((candidate) => {
      const evidence: EvidenceBundle = {
        provider: this.name,
        sourceType: "note",
        title: candidate.title,
        path: candidate.path,
        text: candidate.summary ?? "",
      };
      if (candidate.snippet) {
        evidence.snippet = candidate.snippet;
      }
      if (candidate.matchedFields?.length) {
        evidence.matchedFields = candidate.matchedFields;
      }
      return evidence;
    });
  }
}

export interface SemanticNotesRecallProviderOptions {
  embeddingProvider: EmbeddingProvider;
  vectorIndex: VectorIndex;
  limit?: number;
  filters?: Omit<VectorSearchFilters, "workspaceId">;
}

export class SemanticNotesRecallProvider implements RecallProvider {
  readonly name = "local_semantic_notes";

  private readonly limit: number;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly vectorIndex: VectorIndex;
  private readonly filters: Omit<VectorSearchFilters, "workspaceId">;

  constructor(options: SemanticNotesRecallProviderOptions) {
    this.limit = options.limit ?? 5;
    this.embeddingProvider = options.embeddingProvider;
    this.vectorIndex = options.vectorIndex;
    this.filters = options.filters ?? { excludedStatuses: ["pending_review", "blocked", "rejected"] };
  }

  async prefetch(input: RecallQuery): Promise<EvidenceBundle[]> {
    try {
      const queryVector = await this.embeddingProvider.embedQuery(input.query);
      const filters: VectorSearchFilters = { ...this.filters, workspaceId: input.workspaceId };
      const [noteResults, chunkResults] = await Promise.all([
        this.vectorIndex.searchNotes(queryVector, filters, this.limit),
        this.vectorIndex.searchChunks(queryVector, filters, this.limit * 2),
      ]);
      const candidates = [
        ...noteResults.map((result) => this.noteCandidate(input.db, result)),
        ...chunkResults.map((result) => this.chunkCandidate(input.db, result)),
      ];
      return rerankCandidates(candidates, this.limit);
    } catch {
      // Local semantic retrieval is optional; the lexical provider remains available.
      return [];
    }
  }

  private noteCandidate(db: AppDatabase, result: NoteVectorSearchResult): RerankCandidate {
    const note = db.sqlite.prepare("SELECT title, path, summary FROM notes WHERE id = ?").get(result.noteId) as {
      title: string;
      path: string;
      summary?: string;
    } | undefined;
    return {
      key: `note:${result.noteId}`,
      evidence: {
        provider: this.name,
        sourceType: "note",
        title: note?.title ?? result.noteId,
        path: note?.path ?? "",
        text: note?.summary ?? "",
        ...(note?.summary ? { snippet: note.summary } : {}),
        score: result.score,
        noteId: result.noteId,
        matchedFields: ["title", "summary", "content_category"],
      },
      score: result.score + 0.02,
    };
  }

  private chunkCandidate(db: AppDatabase, result: { chunkId: string; noteId: string; score: number }): RerankCandidate {
    const chunk = db.sqlite.prepare(
      `SELECT c.text, c.path, c.heading_path as headingPath, c.start_line as startLine,
        c.end_line as endLine, n.title
       FROM chunks c JOIN notes n ON n.id = c.note_id
       WHERE c.id = ?`,
    ).get(result.chunkId) as {
      text: string;
      path: string;
      headingPath: string;
      startLine: number;
      endLine: number;
      title: string;
    } | undefined;
    const headingPath = parseHeadingPath(chunk?.headingPath);
    return {
      key: `chunk:${result.chunkId}`,
      evidence: {
        provider: this.name,
        sourceType: "note",
        title: chunk?.title ?? result.noteId,
        path: chunk?.path ?? "",
        text: chunk?.text ?? "",
        ...(chunk?.text === undefined ? {} : { snippet: chunk.text }),
        score: result.score,
        noteId: result.noteId,
        chunkId: result.chunkId,
        ...(headingPath.length ? { headingPath } : {}),
        ...(chunk === undefined ? {} : { startLine: chunk.startLine, endLine: chunk.endLine }),
        matchedFields: ["body", "heading"],
      },
      score: result.score,
    };
  }
}

export interface HybridNotesRecallProviderOptions {
  embeddingProvider: EmbeddingProvider;
  vectorIndex: VectorIndex;
  limit?: number;
  maxChunksPerNote?: number;
  filters?: Omit<VectorSearchFilters, "workspaceId">;
  rrfK?: number;
}

export class HybridNotesRecallProvider implements RecallProvider {
  readonly name = "local_hybrid_notes";

  private readonly limit: number;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly vectorIndex: VectorIndex;
  private readonly filters: Omit<VectorSearchFilters, "workspaceId">;
  private readonly rrfK: number;
  private readonly maxChunksPerNote: number;

  constructor(options: HybridNotesRecallProviderOptions) {
    this.limit = options.limit ?? 5;
    this.embeddingProvider = options.embeddingProvider;
    this.vectorIndex = options.vectorIndex;
    this.filters = options.filters ?? { excludedStatuses: ["pending_review", "blocked", "rejected"] };
    this.rrfK = options.rrfK ?? 60;
    this.maxChunksPerNote = options.maxChunksPerNote ?? 2;
  }

  async prefetch(input: RecallQuery): Promise<EvidenceBundle[]> {
    const filters: VectorSearchFilters = { ...this.filters, workspaceId: input.workspaceId };
    const lexicalPromise = searchNotes(input.db, input.query, {
      workspaceId: input.workspaceId,
      limit: this.limit * 4,
      ...(filters.excludedStatuses ? { excludedStatuses: filters.excludedStatuses } : {}),
      ...(filters.statuses ? { statuses: filters.statuses } : {}),
      ...(filters.sensitivities ? { sensitivities: filters.sensitivities } : {}),
      ...(filters.categories ? { categories: filters.categories } : {}),
    }).catch((): NoteSearchResult[] => []);
    const semanticPromise = this.embeddingProvider.embedQuery(input.query)
      .then(async (queryVector) => {
        const [noteResults, chunkResults] = await Promise.all([
          this.vectorIndex.searchNotes(queryVector, filters, this.limit * 4)
            .catch((): NoteVectorSearchResult[] => []),
          this.vectorIndex.searchChunks(queryVector, filters, this.limit * 8)
            .catch((): ChunkVectorSearchResult[] => []),
        ]);
        return { noteResults, chunkResults };
      })
      .catch(() => ({
        noteResults: [] as NoteVectorSearchResult[],
        chunkResults: [] as ChunkVectorSearchResult[],
      }));

    try {
      const [lexicalResults, semanticResults] = await Promise.all([lexicalPromise, semanticPromise]);
      return this.rerankHybridCandidates(
        input.db,
        lexicalResults,
        semanticResults.noteResults,
        semanticResults.chunkResults,
      );
    } catch {
      return [];
    }
  }

  private rerankHybridCandidates(
    db: AppDatabase,
    lexicalResults: NoteSearchResult[],
    noteResults: NoteVectorSearchResult[],
    chunkResults: ChunkVectorSearchResult[],
  ): EvidenceBundle[] {
    const lexicalRanks = rankBy(lexicalResults, (result) => result.noteId);
    const noteRanks = rankBy(noteResults, (result) => result.noteId);
    const chunkNoteRanks = rankBy(chunkResults, (result) => result.noteId);
    const lexicalByNote = new Map(lexicalResults.map((result) => [result.noteId, result]));
    const semanticByNote = new Map(noteResults.map((result) => [result.noteId, result]));
    const chunksByNote = new Map<string, ChunkVectorSearchResult[]>();

    for (const result of chunkResults) {
      const existing = chunksByNote.get(result.noteId) ?? [];
      existing.push(result);
      chunksByNote.set(result.noteId, existing);
    }

    const noteIds = new Set([
      ...lexicalResults.map((result) => result.noteId),
      ...noteResults.map((result) => result.noteId),
      ...chunkResults.map((result) => result.noteId),
    ]);
    const groups = [...noteIds].map((noteId) => {
      const score = rrfScore(lexicalRanks.get(noteId), this.rrfK)
        + rrfScore(noteRanks.get(noteId), this.rrfK)
        + rrfScore(chunkNoteRanks.get(noteId), this.rrfK);
      const chunks = (chunksByNote.get(noteId) ?? [])
        .slice(0, this.maxChunksPerNote)
        .map((result) => this.chunkEvidence(db, result, score));
      const evidence = chunks.length > 0
        ? chunks
        : [this.noteEvidence(db, noteId, lexicalByNote.get(noteId), semanticByNote.get(noteId), score)];
      return { noteId, score, evidence };
    }).sort((left, right) => right.score - left.score || left.noteId.localeCompare(right.noteId));

    const results: EvidenceBundle[] = [];
    for (let candidateIndex = 0; results.length < this.limit; candidateIndex += 1) {
      let added = false;
      for (const group of groups) {
        const evidence = group.evidence[candidateIndex];
        if (evidence === undefined) continue;
        results.push(evidence);
        added = true;
        if (results.length >= this.limit) break;
      }
      if (!added) break;
    }
    return results;
  }

  private noteEvidence(
    db: AppDatabase,
    noteId: string,
    lexicalResult: NoteSearchResult | undefined,
    semanticResult: NoteVectorSearchResult | undefined,
    score: number,
  ): EvidenceBundle {
    if (lexicalResult !== undefined) {
      return {
        provider: this.name,
        sourceType: "note",
        title: lexicalResult.title,
        path: lexicalResult.path,
        text: lexicalResult.summary ?? lexicalResult.snippet ?? "",
        ...(lexicalResult.summary
          ? { snippet: lexicalResult.summary }
          : lexicalResult.snippet
            ? { snippet: lexicalResult.snippet }
            : {}),
        ...(lexicalResult.matchedFields?.length ? { matchedFields: lexicalResult.matchedFields } : {}),
        score,
        noteId,
      };
    }

    const note = db.sqlite.prepare("SELECT title, path, summary FROM notes WHERE id = ?").get(noteId) as {
      title: string;
      path: string;
      summary?: string;
    } | undefined;
    return {
      provider: this.name,
      sourceType: "note",
      title: note?.title ?? noteId,
      path: note?.path ?? "",
      text: note?.summary ?? "",
      ...(note?.summary ? { snippet: note.summary } : {}),
      score,
      noteId,
      ...(semanticResult === undefined ? {} : { matchedFields: ["title", "summary", "content_category"] }),
    };
  }

  private chunkEvidence(db: AppDatabase, result: ChunkVectorSearchResult, score: number): EvidenceBundle {
    const chunk = db.sqlite.prepare(
      `SELECT c.text, c.path, c.heading_path as headingPath, c.start_line as startLine,
        c.end_line as endLine, n.title
       FROM chunks c JOIN notes n ON n.id = c.note_id
       WHERE c.id = ?`,
    ).get(result.chunkId) as {
      text: string;
      path: string;
      headingPath: string;
      startLine: number;
      endLine: number;
      title: string;
    } | undefined;
    const headingPath = parseHeadingPath(chunk?.headingPath);
    return {
      provider: this.name,
      sourceType: "note",
      title: chunk?.title ?? result.noteId,
      path: chunk?.path ?? "",
      text: chunk?.text ?? "",
      ...(chunk?.text === undefined ? {} : { snippet: chunk.text }),
      score,
      noteId: result.noteId,
      chunkId: result.chunkId,
      ...(headingPath.length ? { headingPath } : {}),
      ...(chunk === undefined ? {} : { startLine: chunk.startLine, endLine: chunk.endLine }),
      matchedFields: ["body", "heading"],
    };
  }
}

function rankBy<T>(results: T[], keyOf: (result: T) => string): Map<string, number> {
  const ranks = new Map<string, number>();
  results.forEach((result, index) => {
    const key = keyOf(result);
    if (!ranks.has(key)) ranks.set(key, index + 1);
  });
  return ranks;
}

function rrfScore(rank: number | undefined, k: number): number {
  return rank === undefined ? 0 : 1 / (k + rank);
}

function parseHeadingPath(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}
