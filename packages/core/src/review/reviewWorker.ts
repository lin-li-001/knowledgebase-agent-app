import type { ModelProvider } from "@kb-agent/model";
import { executeToolCall, type ToolHandler } from "../tools/toolExecutor";
import { createToolRegistry, type MvpToolName, type ToolDefinition } from "../tools/toolRegistry";
import { reviewWorkerPrompt } from "./reviewPrompt";

export type CompletedTurnState = "completed" | "interrupted" | "error";

export interface CompletedTurn {
  id: string;
  workspaceId: string;
  sessionId: string;
  userMessage: string;
  assistantMessage: string;
  state: CompletedTurnState;
  reviewedAt?: string;
}

export interface RunReviewJobInput {
  turn: CompletedTurn;
  modelProvider: ModelProvider;
  model: string;
  handlers: Map<MvpToolName, ToolHandler>;
}

export interface ReviewJobResult {
  state: "skipped" | "reviewed";
  reason?: string;
  toolCalls: string[];
}

const allowedWorkerTools = new Set<MvpToolName>([
  "search_notes",
  "read_note",
  "propose_create_note",
  "propose_memory",
  "propose_decision",
]);

const eligibilityPatterns = [
  /\bremember\b/i,
  /\bprefer(?:s|red|ence)?\b/i,
  /\bmy name is\b/i,
  /\bi am\b/i,
  /\bi have\b/i,
  /\bmy (?:kid|kids|child|children|family|school|education|degree|job|role|company|project)\b/i,
  /\bdecided?\b/i,
  /\bdecision\b/i,
  /\bimport\b/i,
  /\bsummary\b/i,
  /\butility bills?\b/i,
  /水电|账单|导入|总结|记住/,
];

export function isReviewEligible(turn: CompletedTurn): boolean {
  if (turn.state !== "completed") {
    return false;
  }
  if (turn.reviewedAt) {
    return false;
  }

  const message = turn.userMessage.trim();
  if (!message) {
    return false;
  }

  return eligibilityPatterns.some((pattern) => pattern.test(message));
}

export async function enqueueReview(turn: CompletedTurn): Promise<ReviewJobResult> {
  if (!isReviewEligible(turn)) {
    return { state: "skipped", reason: "Turn is not eligible for review", toolCalls: [] };
  }

  return { state: "reviewed", toolCalls: [] };
}

export async function runReviewJob(input: RunReviewJobInput): Promise<ReviewJobResult> {
  if (!isReviewEligible(input.turn)) {
    return { state: "skipped", reason: "Turn is not eligible for review", toolCalls: [] };
  }

  const registry = createReviewWorkerRegistry();
  const response = await input.modelProvider.complete({
    model: input.model,
    messages: [{ role: "system", content: reviewWorkerPrompt(input.turn) }],
    tools: [...registry.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    })),
  });

  const toolCalls: string[] = [];
  for (const toolCall of response.toolCalls ?? []) {
    if (!allowedWorkerTools.has(toolCall.name as MvpToolName)) {
      throw new Error(`Review worker cannot call tool: ${toolCall.name}`);
    }

    const args = JSON.parse(toolCall.argumentsJson || "{}") as unknown;
    await executeToolCall(registry, input.handlers, toolCall.name, args);
    toolCalls.push(toolCall.name);
  }

  return { state: "reviewed", toolCalls };
}

function createReviewWorkerRegistry(): Map<MvpToolName, ToolDefinition> {
  const registry = createToolRegistry();
  return new Map(
    [...registry.entries()].filter(([name]) => allowedWorkerTools.has(name)),
  );
}
