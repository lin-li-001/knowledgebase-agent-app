import { appendMessage, type AppDatabase } from "@kb-agent/storage";
import type { ModelMessage, ModelProvider, ModelResponse, ModelToolCall } from "@kb-agent/model";
import { executeToolCall, type ToolHandler } from "../tools/toolExecutor";
import { createToolRegistry, type MvpToolName } from "../tools/toolRegistry";
import { runReviewJob } from "../review/reviewWorker";
import { buildTurnContext } from "./contextBuilder";
import { buildRequestMessages } from "./requestMessages";
import { finalizeTurn } from "./turnFinalizer";

export type TurnEvent =
  | { type: "sources"; sources: SourceEvent[] }
  | { type: "message"; content: string }
  | { type: "tool_call"; toolCall: ModelToolCall }
  | { type: "tool_result"; toolCallId: string; result: unknown }
  | { type: "done"; response: ModelResponse }
  | { type: "interrupted" }
  | { type: "error"; error: string };

export interface SourceEvent {
  provider?: string;
  sourceType?: string;
  title: string;
  path: string;
  text: string;
  snippet?: string;
  matchedFields?: string[];
}

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
    const sources = sourceEvents(context.snippets);
    if (sources.length) {
      yield { type: "sources", sources };
    }

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
    const transcript: ModelMessage[] = [...messages];

    let response = await input.modelProvider.complete({
      model: input.model,
      messages: transcript,
      tools: [...registry.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema,
      })),
    });

    for (let callCount = 0; callCount < 8 && response.toolCalls?.length; callCount += 1) {
      transcript.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const toolCall of response.toolCalls) {
        yield { type: "tool_call", toolCall };
        const args = JSON.parse(toolCall.argumentsJson || "{}") as unknown;
        const result = await executeToolCall(registry, handlers, toolCall.name, args);
        const content = boundToolResult(result);
        yield { type: "tool_result", toolCallId: toolCall.id, result };
        transcript.push({
          role: "tool",
          content,
          toolCallId: toolCall.id,
        });
        await appendMessage(input.db, {
          id: `${input.sessionId}:tool:${toolCall.id}`,
          sessionId: input.sessionId,
          role: "tool",
          content,
          toolResult: result,
          createdAt: now,
        });
      }

      response = await input.modelProvider.complete({
        model: input.model,
        messages: transcript,
      });
    }

    if (response.content) {
      yield { type: "message", content: response.content };
    }

    const assistantMessageId = `${input.sessionId}:assistant:${Date.now()}`;
    await finalizeTurn({
      db: input.db,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      assistantMessageId,
      response,
      createdAt: now,
    });

    await runReviewJob({
      turn: {
        id: assistantMessageId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        userMessage: input.userMessage,
        assistantMessage: response.content,
        state: "completed",
      },
      modelProvider: input.modelProvider,
      model: input.model,
      handlers,
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

function sourceEvents(snippets: Awaited<ReturnType<typeof buildTurnContext>>["snippets"]): SourceEvent[] {
  return snippets.map((snippet) => {
    const source: SourceEvent = {
      title: snippet.title,
      path: snippet.path,
      text: snippet.text,
    };
    if (snippet.provider) {
      source.provider = snippet.provider;
    }
    if (snippet.sourceType) {
      source.sourceType = snippet.sourceType;
    }
    if (snippet.snippet) {
      source.snippet = snippet.snippet;
    }
    if (snippet.matchedFields?.length) {
      source.matchedFields = snippet.matchedFields;
    }
    return source;
  });
}
