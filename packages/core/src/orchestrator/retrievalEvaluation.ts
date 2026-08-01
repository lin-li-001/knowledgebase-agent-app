import type { EvidenceBundle, RecallProvider, RecallQuery } from "./recallProvider";

export interface RetrievalEvaluationCase {
  id: string;
  query: string;
  expectedNoteIds: string[];
  expectedChunkIds?: string[];
}

export interface RetrievalEvaluationCaseResult {
  id: string;
  query: string;
  retrieved: EvidenceBundle[];
  hit: boolean;
  reciprocalRank: number;
}

export interface RetrievalEvaluationResult {
  k: number;
  cases: RetrievalEvaluationCaseResult[];
  recallAtK: number;
  meanReciprocalRank: number;
}

export async function evaluateRecallProvider(
  provider: RecallProvider,
  input: Omit<RecallQuery, "query">,
  cases: RetrievalEvaluationCase[],
  k = 5,
): Promise<RetrievalEvaluationResult> {
  const caseResults: RetrievalEvaluationCaseResult[] = [];
  for (const evaluationCase of cases) {
    const retrieved = (await provider.prefetch({ ...input, query: evaluationCase.query })).slice(0, k);
    const reciprocalRank = reciprocalRankFor(retrieved, evaluationCase);
    caseResults.push({
      id: evaluationCase.id,
      query: evaluationCase.query,
      retrieved,
      hit: reciprocalRank > 0,
      reciprocalRank,
    });
  }
  const hitCount = caseResults.filter((result) => result.hit).length;
  return {
    k,
    cases: caseResults,
    recallAtK: cases.length === 0 ? 0 : hitCount / cases.length,
    meanReciprocalRank: cases.length === 0
      ? 0
      : caseResults.reduce((sum, result) => sum + result.reciprocalRank, 0) / cases.length,
  };
}

function reciprocalRankFor(results: EvidenceBundle[], evaluationCase: RetrievalEvaluationCase): number {
  const expectedNotes = new Set(evaluationCase.expectedNoteIds);
  const expectedChunks = new Set(evaluationCase.expectedChunkIds ?? []);
  const index = results.findIndex((result) => (
    (result.noteId !== undefined && expectedNotes.has(result.noteId))
    || (result.chunkId !== undefined && expectedChunks.has(result.chunkId))
  ));
  return index === -1 ? 0 : 1 / (index + 1);
}
