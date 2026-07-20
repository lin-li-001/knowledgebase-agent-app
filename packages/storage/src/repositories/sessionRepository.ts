import type { AppDatabase, SessionMessage } from "../types";

export async function appendMessage(db: AppDatabase, message: SessionMessage): Promise<void> {
  const insert = db.sqlite.transaction(() => {
    db.sqlite
      .prepare(
        `INSERT INTO messages (
          id, session_id, role, content, tool_calls_json, tool_result_json,
          active, compacted, created_at
        ) VALUES (
          @id, @sessionId, @role, @content, @toolCallsJson, @toolResultJson,
          @active, @compacted, @createdAt
        )`,
      )
      .run({
        ...message,
        toolCallsJson: message.toolCalls === undefined ? null : JSON.stringify(message.toolCalls),
        toolResultJson: message.toolResult === undefined ? null : JSON.stringify(message.toolResult),
        active: message.active === false ? 0 : 1,
        compacted: message.compacted === true ? 1 : 0,
      });

    db.sqlite
      .prepare(
        `INSERT INTO message_fts (message_id, session_id, content, role)
        VALUES (?, ?, ?, ?)`,
      )
      .run(message.id, message.sessionId, message.content, message.role);
    db.sqlite
      .prepare(
        `INSERT INTO message_fts_trigram (message_id, session_id, content, role)
        VALUES (?, ?, ?, ?)`,
      )
      .run(message.id, message.sessionId, message.content, message.role);
  });

  insert();
}
