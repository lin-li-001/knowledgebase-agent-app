import { describe, expect, it } from "vitest";
import { openAppDatabase, type VectorIndex } from "@kb-agent/storage";
import { SemanticNotesRecallProvider } from "../src/orchestrator/recallProvider";

describe("SemanticNotesRecallProvider", () => {
  it("embeds the query, searches notes and chunks, and returns source provenance", async () => {
    const db = openAppDatabase(":memory:");
    db.sqlite.prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("workspace-1", "/tmp/kb", "2026-07-31", "2026-07-31");
    db.sqlite.prepare(
      `INSERT INTO notes (id, workspace_id, path, title, type, status, owner, scope, sensitivity, content_category, tags_json, summary, summary_source, content_hash, modified_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("note-1", "workspace-1", "03-Knowledge/Handbook.md", "Handbook", "resource", "active", "default", "personal", "normal", "resource", "[]", "Employee handbook", "frontmatter", "hash", "2026-07-31", "2026-07-31");
    db.sqlite.prepare(
      `INSERT INTO chunks (id, note_id, path, heading_path, text, start_line, end_line, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("chunk-1", "note-1", "03-Knowledge/Handbook.md", "[\"Leave\"]", "Leave is four weeks.", 12, 14, 5);

    let queryText = "";
    let seenFilters: unknown;
    const vectorIndex: VectorIndex = {
      async upsertNotes() {},
      async upsertChunks() {},
      async deleteNotes() {},
      async deleteChunks() {},
      async searchNotes(_vector, filters) {
        seenFilters = filters;
        return [{ noteId: "note-1", workspaceId: "workspace-1", score: 0.7, status: "active", sensitivity: "normal", category: "resource" }];
      },
      async searchChunks() {
        return [{ chunkId: "chunk-1", noteId: "note-1", workspaceId: "workspace-1", score: 0.95, status: "active", sensitivity: "normal", category: "resource" }];
      },
    };
    const provider = new SemanticNotesRecallProvider({
      embeddingProvider: {
        modelId: () => "bge-m3",
        dimensions: () => 1024,
        async embedDocuments() { return []; },
        async embedQuery(value) { queryText = value; return Array.from({ length: 1024 }, () => 0); },
      },
      vectorIndex,
      limit: 2,
    });

    const evidence = await provider.prefetch({
      db,
      workspaceId: "workspace-1",
      workspaceRoot: "/tmp/kb",
      query: "How much leave do I get?",
    });

    expect(queryText).toBe("How much leave do I get?");
    expect(seenFilters).toEqual(expect.objectContaining({
      workspaceId: "workspace-1",
      excludedStatuses: ["pending_review", "blocked", "rejected"],
    }));
    expect(evidence[0]).toMatchObject({
      chunkId: "chunk-1",
      text: "Leave is four weeks.",
      headingPath: ["Leave"],
      startLine: 12,
      endLine: 14,
    });
    db.close();
  });
});
