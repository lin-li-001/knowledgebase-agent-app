import { describe, expect, it } from "vitest";
import type { EvidenceBundle, RecallProvider } from "../src/orchestrator/recallProvider";
import { evaluateRecallProvider, type RetrievalEvaluationCase } from "../src/orchestrator/retrievalEvaluation";

const fixtures: RetrievalEvaluationCase[] = [
  { id: "leave-policy", query: "How much leave do I get?", expectedNoteIds: ["note-handbook"], expectedChunkIds: ["chunk-leave"] },
  { id: "project-decision", query: "Which database did we choose?", expectedNoteIds: ["note-project"], expectedChunkIds: ["chunk-database"] },
  { id: "unknown", query: "What is the office color?", expectedNoteIds: ["note-missing"] },
];

describe("retrieval evaluation", () => {
  it("computes Recall@K and MRR from synthetic source fixtures", async () => {
    const provider: RecallProvider = {
      name: "fixture",
      async prefetch(input): Promise<EvidenceBundle[]> {
        if (input.query.includes("leave")) {
          return [{ provider: "fixture", sourceType: "note", title: "Handbook", path: "Handbook.md", text: "Leave", noteId: "note-handbook", chunkId: "chunk-leave" }];
        }
        if (input.query.includes("database")) {
          return [{ provider: "fixture", sourceType: "note", title: "Project", path: "Project.md", text: "SQLite", noteId: "note-project", chunkId: "chunk-database" }];
        }
        return [];
      },
    };

    const result = await evaluateRecallProvider(provider, {
      db: {} as never,
      workspaceId: "workspace-fixture",
      workspaceRoot: "/tmp/fixture",
    }, fixtures, 3);

    expect(result.k).toBe(3);
    expect(result.recallAtK).toBeCloseTo(2 / 3);
    expect(result.meanReciprocalRank).toBeCloseTo(2 / 3);
    expect(result.cases[2]).toMatchObject({ id: "unknown", hit: false, reciprocalRank: 0 });
  });
});
