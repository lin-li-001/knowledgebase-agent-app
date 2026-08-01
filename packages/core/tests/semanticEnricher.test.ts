import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@kb-agent/model";
import type { ImportedChunk } from "@kb-agent/workspace";
import { ModelSemanticImportEnricher } from "../src/imports/semanticEnricher";

describe("ModelSemanticImportEnricher", () => {
  it("parses a strict JSON classification and preserves semantic fields", async () => {
    const provider = {
      complete: async () => ({
        role: "assistant" as const,
        content: "```json\n{\"summary\":\"A handbook describing leave policy.\",\"primaryCategory\":\"resource\",\"alternativeCategories\":[],\"sensitivity\":\"normal\",\"confidence\":0.91,\"evidence\":[\"leave policy\"]}\n```",
      }),
    };
    const enricher = new ModelSemanticImportEnricher(provider as unknown as ModelProvider, "test-model");

    await expect(enricher.enrich({
      title: "Handbook",
      body: "Opening paragraph.\n\nDetailed leave policy.",
      chunks: [],
    })).resolves.toMatchObject({
      summary: "A handbook describing leave policy.",
      primaryCategory: "resource",
      sensitivity: "normal",
      confidence: 0.91,
    });
  });

  it("analyzes source chunks before producing the document-level result", async () => {
    let callCount = 0;
    const provider = {
      complete: async () => {
        callCount += 1;
        return {
          role: "assistant" as const,
          content: "{\"summary\":\"A handbook describing leave policy.\",\"primaryCategory\":\"resource\",\"alternativeCategories\":[],\"sensitivity\":\"normal\",\"confidence\":0.91,\"evidence\":[\"leave policy\"]}",
        };
      },
    };
    const chunks: ImportedChunk[] = [
      { id: "chunk-1", noteId: "note-1", text: "Leave policy.", headingPath: ["Leave"], startLine: 1, endLine: 2, tokenCount: 2 },
      { id: "chunk-2", noteId: "note-1", text: "Benefits policy.", headingPath: ["Benefits"], startLine: 3, endLine: 4, tokenCount: 2 },
    ];
    const enricher = new ModelSemanticImportEnricher(provider as unknown as ModelProvider, "test-model");

    await enricher.enrich({ title: "Handbook", body: "Leave policy.\nBenefits policy.", chunks });

    expect(callCount).toBe(3);
  });
});
