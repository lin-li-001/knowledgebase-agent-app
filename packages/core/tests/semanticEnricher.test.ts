import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@kb-agent/model";
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
});
