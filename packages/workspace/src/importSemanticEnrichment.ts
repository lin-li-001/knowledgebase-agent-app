import { z } from "zod";
import {
  builtInContentCategoryCatalog,
  type ContentCategory,
  type ContentCategoryDefinition,
} from "./contentCategories";
import type { ImportSensitivity } from "./importSafety";
import type { ImportedChunk } from "./importChunks";

export interface SemanticImportInput {
  title: string;
  body: string;
  chunks: ImportedChunk[];
  categories?: ContentCategoryDefinition[];
}

export interface SemanticImportResult {
  summary: string;
  primaryCategory: ContentCategory;
  alternativeCategories: ContentCategory[];
  sensitivity: ImportSensitivity;
  confidence: number;
  evidence: string[];
}

export interface SemanticImportEnricher {
  enrich(input: SemanticImportInput): Promise<SemanticImportResult>;
}

const sensitivities = ["normal", "personal", "private", "restricted"] as const;

const semanticResultSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  primaryCategory: z.string().trim().min(1).max(120),
  alternativeCategories: z.array(z.string().trim().min(1).max(120)).default([]),
  sensitivity: z.enum(sensitivities),
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(z.string().trim().min(1).max(240)).default([]),
});

export function normalizeSemanticImportResult(value: unknown, input: SemanticImportInput): SemanticImportResult {
  const parsed = semanticResultSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0] ? ` ${String(issue.path[0])}` : "";
    throw new Error(`Invalid semantic import result${field}: ${issue?.message ?? "unknown error"}`);
  }

  if (!input.title.trim() || !input.body.trim()) {
    throw new Error("Semantic import input must include a title and body");
  }

  const result = parsed.data;
  const allowedCategoryIds = new Set(
    (input.categories ?? builtInContentCategoryCatalog).map((category) => category.id),
  );
  if (!allowedCategoryIds.has(result.primaryCategory)) {
    throw new Error(`Invalid semantic import result primaryCategory: ${result.primaryCategory}`);
  }
  const invalidAlternative = result.alternativeCategories.find((category) => !allowedCategoryIds.has(category));
  if (invalidAlternative !== undefined) {
    throw new Error(`Invalid semantic import result alternativeCategories: ${invalidAlternative}`);
  }
  return {
    summary: result.summary,
    primaryCategory: result.primaryCategory,
    alternativeCategories: [...new Set(result.alternativeCategories)].filter(
      (category) => category !== result.primaryCategory,
    ),
    sensitivity: result.sensitivity,
    confidence: result.confidence,
    evidence: [...new Set(result.evidence)],
  };
}
