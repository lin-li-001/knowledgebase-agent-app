import { describe, expect, it } from "vitest";
import {
  normalizeSemanticImportResult,
  type SemanticImportInput,
} from "../src/importSemanticEnrichment";

const input: SemanticImportInput = {
  title: "Handbook",
  body: "Employee leave policy",
  chunks: [],
};

describe("normalizeSemanticImportResult", () => {
  it("normalizes a valid semantic result", () => {
    expect(normalizeSemanticImportResult({
      summary: "A handbook describing employee leave policy.",
      primaryCategory: "resource",
      alternativeCategories: [],
      sensitivity: "normal",
      confidence: 0.91,
      evidence: ["Leave policy heading"],
    }, input)).toEqual({
      summary: "A handbook describing employee leave policy.",
      primaryCategory: "resource",
      alternativeCategories: [],
      sensitivity: "normal",
      confidence: 0.91,
      evidence: ["Leave policy heading"],
    });
  });

  it("rejects invalid category and sensitivity instead of inventing values", () => {
    expect(() => normalizeSemanticImportResult({
      summary: "",
      primaryCategory: "not-a-category",
      alternativeCategories: [],
      sensitivity: "secret",
      confidence: 1.4,
      evidence: [],
    }, input)).toThrow("Invalid semantic import result");
  });

  it("rejects a missing summary", () => {
    expect(() => normalizeSemanticImportResult({
      primaryCategory: "resource",
      sensitivity: "normal",
      confidence: 0.8,
      evidence: [],
    }, input)).toThrow("summary");
  });
});
