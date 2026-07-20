import { appendMessage, recordActivity, type AppDatabase } from "@kb-agent/storage";
import type { ModelResponse } from "@kb-agent/model";

export async function finalizeTurn(input: {
  db: AppDatabase;
  workspaceId: string;
  sessionId: string;
  assistantMessageId: string;
  response: ModelResponse;
  createdAt: string;
}): Promise<void> {
  await appendMessage(input.db, {
    id: input.assistantMessageId,
    sessionId: input.sessionId,
    role: "assistant",
    content: input.response.content,
    toolCalls: input.response.toolCalls,
    createdAt: input.createdAt,
  });

  await recordActivity(input.db, {
    id: `${input.assistantMessageId}:activity`,
    workspaceId: input.workspaceId,
    kind: "chat",
    title: "Chat turn completed",
    message: "Assistant response saved. Review Worker not enabled in v0.1A.",
    createdAt: input.createdAt,
  });
}
