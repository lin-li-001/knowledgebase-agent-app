import { describe, expect, it } from "vitest";
import { openAppDatabase, type VectorIndex } from "@kb-agent/storage";
import { HybridNotesRecallProvider, SemanticNotesRecallProvider } from "../src/orchestrator/recallProvider";

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

describe("HybridNotesRecallProvider", () => {
  it("fuses lexical note hits with semantic note and chunk hits using RRF", async () => {
    const db = openAppDatabase(":memory:");
    db.sqlite.prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("workspace-1", "/tmp/kb", "2026-07-31", "2026-07-31");
    db.sqlite.prepare(
      `INSERT INTO notes (id, workspace_id, path, title, type, status, owner, scope, sensitivity, content_category, tags_json, summary, summary_source, content_hash, modified_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("note-1", "workspace-1", "03-Knowledge/Handbook.md", "Handbook", "resource", "active", "default", "personal", "normal", "resource", "[]", "Employee leave policy", "frontmatter", "hash", "2026-07-31", "2026-07-31");
    db.sqlite.prepare(
      "INSERT INTO note_fts (note_id, workspace_id, title, summary, headings, body, path) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("note-1", "workspace-1", "Handbook", "Employee leave policy", "Leave", "Leave is four weeks.", "03-Knowledge/Handbook.md");
    db.sqlite.prepare(
      `INSERT INTO chunks (id, note_id, path, heading_path, text, start_line, end_line, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("chunk-1", "note-1", "03-Knowledge/Handbook.md", "[\"Leave\"]", "Leave is four weeks.", 12, 14, 5);

    const vectorIndex: VectorIndex = {
      async upsertNotes() {},
      async upsertChunks() {},
      async deleteNotes() {},
      async deleteChunks() {},
      async searchNotes() {
        return [{ noteId: "note-1", workspaceId: "workspace-1", score: 0.7, status: "active", sensitivity: "normal", category: "resource" }];
      },
      async searchChunks() {
        return [{ chunkId: "chunk-1", noteId: "note-1", workspaceId: "workspace-1", score: 0.95, status: "active", sensitivity: "normal", category: "resource" }];
      },
    };
    const provider = new HybridNotesRecallProvider({
      embeddingProvider: {
        modelId: () => "bge-m3",
        dimensions: () => 1024,
        async embedDocuments() { return []; },
        async embedQuery() { return Array.from({ length: 1024 }, () => 0); },
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

    expect(evidence[0]).toMatchObject({
      provider: "local_hybrid_notes",
      chunkId: "chunk-1",
      text: "Leave is four weeks.",
      headingPath: ["Leave"],
      startLine: 12,
      endLine: 14,
    });
    db.close();
  });

  it("returns lexical results when query embedding is unavailable", async () => {
    const db = openAppDatabase(":memory:");
    db.sqlite.prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("workspace-1", "/tmp/kb", "2026-07-31", "2026-07-31");
    db.sqlite.prepare(
      `INSERT INTO notes (id, workspace_id, path, title, type, status, owner, scope, sensitivity, content_category, tags_json, summary, summary_source, content_hash, modified_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("note-1", "workspace-1", "03-Knowledge/Handbook.md", "Handbook", "resource", "active", "default", "personal", "normal", "resource", "[]", "Employee leave policy", "frontmatter", "hash", "2026-07-31", "2026-07-31");
    db.sqlite.prepare(
      "INSERT INTO note_fts (note_id, workspace_id, title, summary, headings, body, path) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("note-1", "workspace-1", "Handbook", "Employee leave policy", "Leave", "Leave is four weeks.", "03-Knowledge/Handbook.md");

    const vectorIndex: VectorIndex = {
      async upsertNotes() {},
      async upsertChunks() {},
      async deleteNotes() {},
      async deleteChunks() {},
      async searchNotes() { throw new Error("vector search should not run"); },
      async searchChunks() { throw new Error("vector search should not run"); },
    };
    const provider = new HybridNotesRecallProvider({
      embeddingProvider: {
        modelId: () => "bge-m3",
        dimensions: () => 1024,
        async embedDocuments() { return []; },
        async embedQuery() { throw new Error("Ollama unavailable"); },
      },
      vectorIndex,
      limit: 2,
    });

    const evidence = await provider.prefetch({
      db,
      workspaceId: "workspace-1",
      workspaceRoot: "/tmp/kb",
      query: "employee leave policy",
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      provider: "local_hybrid_notes",
      noteId: "note-1",
      path: "03-Knowledge/Handbook.md",
    });
    db.close();
  });

  it("ranks notes as groups and limits chunks from one document", async () => {
    const db = openAppDatabase(":memory:");
    db.sqlite.prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("workspace-1", "/tmp/kb", "2026-07-31", "2026-07-31");
    const insertNote = db.sqlite.prepare(
      `INSERT INTO notes (id, workspace_id, path, title, type, status, owner, scope, sensitivity, content_category, tags_json, summary, summary_source, content_hash, modified_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertNote.run("note-1", "workspace-1", "03-Knowledge/Long.md", "Long", "resource", "active", "default", "personal", "normal", "resource", "[]", "Leave policy details", "frontmatter", "hash-1", "2026-07-31", "2026-07-31");
    insertNote.run("note-2", "workspace-1", "03-Knowledge/Benefits.md", "Benefits", "resource", "active", "default", "personal", "normal", "resource", "[]", "Leave benefits", "frontmatter", "hash-2", "2026-07-31", "2026-07-31");
    const insertFts = db.sqlite.prepare(
      "INSERT INTO note_fts (note_id, workspace_id, title, summary, headings, body, path) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertFts.run("note-1", "workspace-1", "Long", "Leave policy details", "Leave", "Leave details repeated throughout.", "03-Knowledge/Long.md");
    insertFts.run("note-2", "workspace-1", "Benefits", "Leave benefits", "Benefits", "Leave benefit eligibility.", "03-Knowledge/Benefits.md");
    const insertChunk = db.sqlite.prepare(
      `INSERT INTO chunks (id, note_id, path, heading_path, text, start_line, end_line, token_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertChunk.run("chunk-1a", "note-1", "03-Knowledge/Long.md", "[\"A\"]", "Long document section A.", 10, 12, 4);
    insertChunk.run("chunk-1b", "note-1", "03-Knowledge/Long.md", "[\"B\"]", "Long document section B.", 20, 22, 4);
    insertChunk.run("chunk-1c", "note-1", "03-Knowledge/Long.md", "[\"C\"]", "Long document section C.", 30, 32, 4);
    insertChunk.run("chunk-2a", "note-2", "03-Knowledge/Benefits.md", "[\"Eligibility\"]", "Benefits eligibility section.", 5, 7, 4);

    const vectorIndex: VectorIndex = {
      async upsertNotes() {},
      async upsertChunks() {},
      async deleteNotes() {},
      async deleteChunks() {},
      async searchNotes() {
        return [
          { noteId: "note-1", workspaceId: "workspace-1", score: 0.95, status: "active", sensitivity: "normal", category: "resource" },
          { noteId: "note-2", workspaceId: "workspace-1", score: 0.9, status: "active", sensitivity: "normal", category: "resource" },
        ];
      },
      async searchChunks() {
        return [
          { chunkId: "chunk-1a", noteId: "note-1", workspaceId: "workspace-1", score: 0.99, status: "active", sensitivity: "normal", category: "resource" },
          { chunkId: "chunk-1b", noteId: "note-1", workspaceId: "workspace-1", score: 0.98, status: "active", sensitivity: "normal", category: "resource" },
          { chunkId: "chunk-1c", noteId: "note-1", workspaceId: "workspace-1", score: 0.97, status: "active", sensitivity: "normal", category: "resource" },
          { chunkId: "chunk-2a", noteId: "note-2", workspaceId: "workspace-1", score: 0.96, status: "active", sensitivity: "normal", category: "resource" },
        ];
      },
    };
    const provider = new HybridNotesRecallProvider({
      embeddingProvider: {
        modelId: () => "bge-m3",
        dimensions: () => 1024,
        async embedDocuments() { return []; },
        async embedQuery() { return Array.from({ length: 1024 }, () => 0); },
      },
      vectorIndex,
      limit: 3,
      maxChunksPerNote: 2,
    });

    const evidence = await provider.prefetch({
      db,
      workspaceId: "workspace-1",
      workspaceRoot: "/tmp/kb",
      query: "leave",
    });

    expect(evidence.map((item) => item.noteId)).toEqual(["note-1", "note-2", "note-1"]);
    expect(evidence.filter((item) => item.noteId === "note-1")).toHaveLength(2);
    expect(evidence.some((item) => item.chunkId === "chunk-1c")).toBe(false);
    db.close();
  });
});
