import type { EvidenceBundle } from "./recallProvider";

export interface RerankCandidate {
  key: string;
  score: number;
  evidence: EvidenceBundle;
}

export function rerankCandidates(candidates: RerankCandidate[], limit: number): EvidenceBundle[] {
  const seen = new Set<string>();
  return [...candidates]
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
    .filter((candidate) => {
      if (seen.has(candidate.key)) return false;
      seen.add(candidate.key);
      return true;
    })
    .slice(0, limit)
    .map((candidate) => candidate.evidence);
}
