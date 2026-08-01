import { describe, expect, it } from "vitest";
import { chunkMarkdownBody } from "../src/importChunks";

describe("chunkMarkdownBody", () => {
  it("keeps heading and page provenance while splitting long sections", () => {
    const body = [
      "<!-- Page 1 -->",
      "# Handbook",
      "Opening policy text.",
      "More policy text that should be split into a bounded chunk.",
      "## Leave",
      "Leave policy text.",
      "<!-- Page 2 -->",
      "Additional leave details.",
    ].join("\n");

    const chunks = chunkMarkdownBody(body, { maxCharacters: 70, noteId: "note-1" });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({ noteId: "note-1", headingPath: ["Handbook"], pageNumber: 1 });
    expect(chunks.some((chunk) => chunk.headingPath.includes("Leave") && chunk.pageNumber === 2)).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 70)).toBe(true);
    expect(chunks.every((chunk) => chunk.startLine <= chunk.endLine)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  });

  it("returns no chunks for an empty body", () => {
    expect(chunkMarkdownBody("\n\n", { maxCharacters: 100, noteId: "note-empty" })).toEqual([]);
  });
});
