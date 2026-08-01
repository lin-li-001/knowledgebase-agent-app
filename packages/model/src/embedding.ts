export interface EmbeddingProvider {
  modelId(): string;
  dimensions(): number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface EmbeddingResponse {
  embeddings: number[][];
}
