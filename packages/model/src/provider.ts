export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  role: ModelRole;
  content: string;
  toolCallId?: string;
}

export interface ModelTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools?: ModelTool[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ModelResponse {
  role: "assistant";
  content: string;
  toolCalls?: ModelToolCall[];
}

export type ModelStreamEvent =
  | { type: "content"; content: string }
  | { type: "tool_call"; toolCall: ModelToolCall }
  | { type: "done"; response: ModelResponse };

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export interface ModelProvider {
  complete(input: ModelRequest): Promise<ModelResponse>;
  stream(input: ModelRequest): AsyncIterable<ModelStreamEvent>;
  supportsToolCalling: boolean;
  supportsPromptCache: boolean;
  estimateCost(input: ModelRequest): Promise<CostEstimate>;
}
