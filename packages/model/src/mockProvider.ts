import type {
  CostEstimate,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "./provider";

export class MockProvider implements ModelProvider {
  readonly supportsToolCalling = true;
  readonly supportsPromptCache = false;

  private cursor = 0;
  private readonly script: ModelResponse[];

  constructor(script: ModelResponse[]) {
    this.script = script;
  }

  async complete(_input: ModelRequest): Promise<ModelResponse> {
    const response = this.script[this.cursor];
    if (!response) {
      return {
        role: "assistant",
        content: "Mock response complete.",
      };
    }

    this.cursor += 1;
    return response;
  }

  async *stream(input: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.complete(input);
    if (response.content) {
      yield { type: "content", content: response.content };
    }
    for (const toolCall of response.toolCalls ?? []) {
      yield { type: "tool_call", toolCall };
    }
    yield { type: "done", response };
  }

  async estimateCost(input: ModelRequest): Promise<CostEstimate> {
    return {
      inputTokens: input.messages.reduce((sum, message) => sum + message.content.length, 0),
      outputTokens: 0,
      estimatedUsd: 0,
    };
  }
}
