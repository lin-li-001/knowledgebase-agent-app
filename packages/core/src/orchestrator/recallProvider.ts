import { searchNotes, type AppDatabase } from "@kb-agent/storage";

export type EvidenceSourceType = "note" | "profile" | "memory" | "workspace_rules" | "session";

export interface EvidenceBundle {
  provider: string;
  sourceType: EvidenceSourceType;
  title: string;
  path: string;
  text: string;
  snippet?: string;
  matchedFields?: string[];
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
