import { appendMessage, type AppDatabase } from "@kb-agent/storage";
import type { ModelMessage, ModelProvider, ModelResponse, ModelToolCall } from "@kb-agent/model";
import { executeToolCall, type ToolHandler } from "../tools/toolExecutor";
import { createToolRegistry, type MvpToolName } from "../tools/toolRegistry";
import { buildTurnContext } from "./contextBuilder";
import { buildRequestMessages } from "./requestMessages";
import { finalizeTurn } from "./turnFinalizer";

export type TurnEvent =
  | { type: "message"; content: string }
  | { type: "tool_call"; toolCall: ModelToolCall }
  | { type: "tool_result"; toolCallId: string; result: unknown }
  | { type: "done"; response: ModelResponse }
  | { type: "interrupted" }
  | { type: "error"; error: string };

export interface RunTurnInput {
  db: AppDatabase;
  modelProvider: ModelProvider;
  model: string;
  workspaceId: string;
  workspaceRoot: string;
  sessionId: string;
  userMessage: string;
  recentMessages?: ModelMessage[];
  handlers?: Map<MvpToolName, ToolHandler>;
  signal?: AbortSignal;
  now?: string;
}

const activeSessions = new Set<string>();

export async function* runTurn(input: RunTurnInput): AsyncIterable<TurnEvent> {
  if (activeSessions.has(input.sessionId)) {
    throw new Error("Turn already active for session");
  }

  activeSessions.add(input.sessionId);
  const now = input.now ?? new Date().toISOString();
  const registry = createToolRegistry();
  const handlers = input.handlers ?? new Map<MvpToolName, ToolHandler>();

  try {
    if (input.signal?.aborted) {
      yield { type: "interrupted" };
      return;
    }

    await appendMessage(input.db, {
      id: `${input.sessionId}:user:${Date.now()}`,
      sessionId: input.sessionId,
      role: "user",
      content: input.userMessage,
      createdAt: now,
    });

    const context = await buildTurnContext({
      db: input.db,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      query: input.userMessage,
    });

    const messages = buildRequestMessages(
      [
        { role: "system", content: context.workspaceRules },
        { role: "system", content: context.profile },
        { role: "system", content: context.memory },
        ...(input.recentMessages ?? []),
      ],
      input.userMessage,
      context.snippets,
    );

    let response = await input.modelProvider.complete({
      model: input.model,
      messages,
      tools: [...registry.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    });

    for (let callCount = 0; callCount < 8 && response.toolCalls?.length; callCount += 1) {
      for (const toolCall of response.toolCalls) {
        yield { type: "tool_call", toolCall };
        const args = JSON.parse(toolCall.argumentsJson || "{}") as unknown;
        const result = await executeToolCall(registry, handlers, toolCall.name, args);
        yield { type: "tool_result", toolCallId: toolCall.id, result };
        await appendMessage(input.db, {
          id: `${input.sessionId}:tool:${toolCall.id}`,
          sessionId: input.sessionId,
          role: "tool",
          content: boundToolResult(result),
          toolResult: result,
          createdAt: now,
        });
      }

      response = await input.modelProvider.complete({
        model: input.model,
        messages: [...messages, { role: "assistant", content: response.content }],
      });
    }

    if (response.content) {
      yield { type: "message", content: response.content };
    }

    await finalizeTurn({
      db: input.db,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      assistantMessageId: `${input.sessionId}:assistant:${Date.now()}`,
      response,
      createdAt: now,
    });

    yield { type: "done", response };
  } catch (error) {
    yield { type: "error", error: error instanceof Error ? error.message : "Unknown error" };
  } finally {
    activeSessions.delete(input.sessionId);
  }
}

function boundToolResult(result: unknown): string {
  return JSON.stringify(result).slice(0, 8_000);
}
