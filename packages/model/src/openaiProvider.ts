import type {
  CostEstimate,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelStreamEvent,
} from "./provider";

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAIChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
}

interface OpenAIToolCall {
  id: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export class OpenAIProvider implements ModelProvider {
  readonly supportsToolCalling = true;
  readonly supportsPromptCache = false;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(input: ModelRequest): Promise<ModelResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages.map(serializeMessage),
        tools: input.tools?.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Model request failed: ${response.status}${body ? ` ${body.slice(0, 500)}` : ""}`);
    }

    const json = (await response.json()) as OpenAIChatCompletion;
    const message = json.choices?.[0]?.message;
    const toolCalls = mapToolCalls(message?.tool_calls);

    const modelResponse: ModelResponse = {
      role: "assistant",
      content: message?.content ?? "",
    };
    if (toolCalls) {
      modelResponse.toolCalls = toolCalls;
    }

    return modelResponse;
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
    const inputTokens = input.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    return {
      inputTokens,
      outputTokens: 0,
      estimatedUsd: 0,
    };
  }
}

function serializeMessage(message: ModelMessage): OpenAIMessage {
  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new Error("Tool message missing toolCallId");
    }

    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }

  if (message.role === "assistant") {
    const serialized: OpenAIMessage = {
      role: "assistant",
      content: message.content || null,
    };
    if (message.toolCalls?.length) {
      serialized.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.argumentsJson,
        },
      }));
    }

    return serialized;
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function mapToolCalls(toolCalls: OpenAIToolCall[] | undefined): ModelToolCall[] | undefined {
  if (!toolCalls?.length) {
    return undefined;
  }

  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function?.name ?? "",
    argumentsJson: toolCall.function?.arguments ?? "{}",
  }));
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
