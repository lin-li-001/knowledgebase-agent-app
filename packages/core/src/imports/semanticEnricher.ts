import type { ModelProvider } from "@kb-agent/model";
import {
  builtInContentCategoryCatalog,
  normalizeSemanticImportResult,
  type SemanticImportEnricher,
  type SemanticImportInput,
  type SemanticImportResult,
} from "@kb-agent/workspace";

const MAX_DOCUMENT_CHARS = 120_000;

export class ModelSemanticImportEnricher implements SemanticImportEnricher {
  constructor(
    private readonly modelProvider: ModelProvider,
    private readonly model: string,
  ) {}

  async enrich(input: SemanticImportInput): Promise<SemanticImportResult> {
    const chunkResults = await Promise.all(input.chunks.map(async (chunk) => {
      const result = await this.completeAnalysis(
        input.title,
        chunk.text,
        `Analyze source chunk ${chunk.id}. Focus on the facts and meaning in this chunk.`,
        [],
        input,
      );
      return {
        headingPath: chunk.headingPath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        ...result,
      };
    }));

    return this.completeAnalysis(
      input.title,
      input.body.slice(0, MAX_DOCUMENT_CHARS),
      "Aggregate the complete document. Use the chunk analyses as evidence, resolve conflicts conservatively, and do not copy the opening paragraph as the summary.",
      chunkResults,
      input,
    );
  }

  private async completeAnalysis(
    title: string,
    document: string,
    task: string,
    chunkAnalyses: unknown[] = [],
    input?: SemanticImportInput,
  ): Promise<SemanticImportResult> {
    const response = await this.modelProvider.complete({
      model: this.model,
      messages: [
        {
          role: "system",
          content: [
            "You classify imported knowledge-base documents.",
            "Return JSON only.",
            "Do not return Markdown, a code fence, or extra commentary.",
            "summary must be a concise faithful summary, not a copy of the opening paragraph.",
            "Use exactly one primaryCategory from the allowed list.",
            "Choose the most specific leaf category supported by the document; use a parent only when the document is genuinely broad or evidence is insufficient for a leaf.",
            "The decision category is only for a document whose primary purpose is a formal decision record. For ordinary project or personal decisions embedded in another document, keep the document's primary category.",
            "Use sensitivity normal, personal, private, or restricted.",
            "confidence must be a number from 0 to 1.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            task,
            allowedCategories: (input?.categories ?? builtInContentCategoryCatalog).map((category) => ({
              id: category.id,
              description: category.description,
              examples: category.examples,
            })),
            outputShape: {
              summary: "string",
              primaryCategory: "exactly one ID from allowedCategories",
              alternativeCategories: ["content category strings"],
              sensitivity: "normal | personal | private | restricted",
              confidence: 0.0,
              evidence: ["short phrases from the document supporting the decision"],
            },
            title,
            document,
            chunkAnalyses,
          }),
        },
      ],
    });

    const semanticInput = input ?? {
      title,
      body: document,
      chunks: [],
    };
    return normalizeSemanticImportResult(parseJson(response.content), semanticInput);
  }
}

function parseJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1];
  const candidate = (fenced ?? trimmed).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    }
    throw new Error("Semantic import model returned invalid JSON");
  }
}
