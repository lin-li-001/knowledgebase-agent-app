import { z } from "zod";
import type { ContentCategory, ImportSensitivity } from "./importSafety";
import type { ImportedChunk } from "./importChunks";

export interface SemanticImportInput {
  title: string;
  body: string;
  chunks: ImportedChunk[];
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

const contentCategories = [
  "finance.utility",
  "finance.insurance",
  "finance.tax",
  "finance.statement",
  "profile.career",
  "profile.personal_fact",
  "memory.candidate",
  "decision.record",
  "project.document",
  "resource",
  "unknown",
] as const;

const sensitivities = ["normal", "personal", "private", "restricted"] as const;

const semanticResultSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  primaryCategory: z.enum(contentCategories),
  alternativeCategories: z.array(z.enum(contentCategories)).default([]),
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
