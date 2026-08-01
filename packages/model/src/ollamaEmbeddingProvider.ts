import type { EmbeddingProvider } from "./embedding";

export interface OllamaEmbeddingProviderOptions {
  model?: string;
  baseUrl?: string;
  dimensions: number;
  fetchImpl?: typeof fetch;
}

interface OllamaEmbeddingResponse {
  embeddings?: unknown;
}

export interface EmbeddingServiceStatus {
  available: boolean;
  model: string;
  modelInstalled: boolean;
  error?: string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly expectedDimensions: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaEmbeddingProviderOptions) {
    this.model = options.model ?? "bge-m3";
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/u, "");
    this.expectedDimensions = options.dimensions;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  modelId(): string {
    return this.model;
  }

  dimensions(): number {
    return this.expectedDimensions;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    return this.parseResponse(response, texts.length);
  }

  async embedQuery(text: string): Promise<number[]> {
    const embeddings = await this.embedDocuments([text]);
    const embedding = embeddings[0];
    if (!embedding) {
      throw new Error("Embedding service returned no query embedding");
    }
    return embedding;
  }

  async status(): Promise<EmbeddingServiceStatus> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        return { available: false, model: this.model, modelInstalled: false, error: `Ollama returned HTTP ${response.status}` };
      }
      const json = (await response.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
      const models = Array.isArray(json.models) ? json.models : [];
      const modelInstalled = models.some((entry) =>
        entry.name === this.model
        || entry.model === this.model
        || entry.name === `${this.model}:latest`
        || entry.model === `${this.model}:latest`,
      );
      return { available: true, model: this.model, modelInstalled };
    } catch (error) {
      return {
        available: false,
        model: this.model,
        modelInstalled: false,
        error: error instanceof Error ? error.message : "Unable to connect to Ollama",
      };
    }
  }

  private async parseResponse(response: Response, expectedCount: number): Promise<number[][]> {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embedding request failed: ${response.status}${body ? ` ${body.slice(0, 500)}` : ""}`);
    }

    const json = (await response.json()) as OllamaEmbeddingResponse;
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== expectedCount) {
      throw new Error(`Embedding service returned ${Array.isArray(json.embeddings) ? json.embeddings.length : 0} vectors; expected ${expectedCount}`);
    }

    return json.embeddings.map((value, index) => {
      if (!Array.isArray(value) || value.length !== this.expectedDimensions || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
        throw new Error(`Embedding ${index} has invalid dimensions; expected ${this.expectedDimensions}`);
      }
      return value as number[];
    });
  }
}
