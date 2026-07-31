import { describe, expect, it } from "vitest";
import { OllamaEmbeddingProvider } from "../src/ollamaEmbeddingProvider";

function response(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" }, ...(ok ? {} : { statusText: "error" }) });
}

describe("OllamaEmbeddingProvider", () => {
  it("embeds documents and queries through the local Ollama endpoint", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const provider = new OllamaEmbeddingProvider({
      dimensions: 3,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown });
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        return response({ embeddings: body.input.map((_, index) => index === 0 ? [0.1, 0.2, 0.3] : [0.4, 0.5, 0.6]) });
      },
    });

    await expect(provider.embedDocuments(["a", "b"])).resolves.toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
    await expect(provider.embedQuery("question")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(requests[0]).toEqual({
      url: "http://127.0.0.1:11434/api/embed",
      body: { model: "bge-m3", input: ["a", "b"] },
    });
  });

  it("rejects service failures and wrong vector dimensions", async () => {
    const failing = new OllamaEmbeddingProvider({
      dimensions: 3,
      fetchImpl: async () => response({ error: "offline" }, false, 503),
    });
    await expect(failing.embedQuery("question")).rejects.toThrow("Embedding request failed: 503");

    const malformed = new OllamaEmbeddingProvider({
      dimensions: 3,
      fetchImpl: async () => response({ embeddings: [[0.1, 0.2]] }),
    });
    await expect(malformed.embedQuery("question")).rejects.toThrow("invalid dimensions");
  });
});
