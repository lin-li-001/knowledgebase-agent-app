import { describe, expect, it } from "vitest";
import { openAppDatabase, SqliteVectorIndex } from "../src";

function vector(index: number, value = 1): number[] {
  const result = Array.from({ length: 1024 }, () => 0);
  result[index] = value;
  return result;
}

describe("SqliteVectorIndex", () => {
  it("upserts and searches note and chunk vectors with metadata filters", async () => {
    const db = openAppDatabase(":memory:");
    const index = new SqliteVectorIndex(db.sqlite);
    await index.upsertNotes([
      {
        noteId: "note-1",
        workspaceId: "workspace-1",
        status: "approved",
        sensitivity: "normal",
        category: "resource",
        modelId: "bge-m3",
        contentHash: "hash-1",
        embedding: vector(0),
      },
      {
        noteId: "note-2",
        workspaceId: "workspace-1",
        status: "pending_review",
        sensitivity: "personal",
        category: "profile.career",
        modelId: "bge-m3",
        contentHash: "hash-2",
        embedding: vector(1),
      },
    ]);
    await index.upsertChunks([{
      chunkId: "chunk-1",
      noteId: "note-1",
      workspaceId: "workspace-1",
      status: "approved",
      sensitivity: "normal",
      category: "resource",
      modelId: "bge-m3",
      contentHash: "hash-1",
      embedding: vector(0),
    }]);

    await expect(index.searchNotes(vector(0), { workspaceId: "workspace-1", statuses: ["approved"] }, 5)).resolves.toEqual([
      expect.objectContaining({ noteId: "note-1", score: expect.any(Number) }),
    ]);
    await expect(index.searchChunks(vector(0), { workspaceId: "workspace-1", categories: ["resource"] }, 5)).resolves.toEqual([
      expect.objectContaining({ chunkId: "chunk-1", noteId: "note-1" }),
    ]);

    await index.deleteNotes(["note-1"]);
    await expect(index.searchNotes(vector(0), { workspaceId: "workspace-1" }, 5)).resolves.not.toContainEqual(
      expect.objectContaining({ noteId: "note-1" }),
    );
    db.close();
  });

  it("rejects vectors with the wrong dimensions", async () => {
    const db = openAppDatabase(":memory:");
    const index = new SqliteVectorIndex(db.sqlite);
    await expect(index.upsertNotes([{
      noteId: "note-1",
      workspaceId: "workspace-1",
      status: "approved",
      sensitivity: "normal",
      category: "resource",
      modelId: "bge-m3",
      contentHash: "hash-1",
      embedding: [0, 1],
    }])).rejects.toThrow("exactly 1024");
    db.close();
  });
});
