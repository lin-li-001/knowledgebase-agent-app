import type { ActivityEvent, AppDatabase } from "../types";

export async function recordActivity(db: AppDatabase, event: ActivityEvent): Promise<void> {
  db.sqlite
    .prepare(
      `INSERT INTO activity_events (
        id, workspace_id, kind, title, message, entity_path, review_item_id, created_at
      ) VALUES (
        @id, @workspaceId, @kind, @title, @message, @entityPath, @reviewItemId, @createdAt
      )`,
    )
    .run({
      ...event,
      entityPath: event.entityPath ?? null,
      reviewItemId: event.reviewItemId ?? null,
    });
}

export async function listActivity(
  db: AppDatabase,
  workspaceId: string,
  limit: number,
): Promise<ActivityEvent[]> {
  return db.sqlite
    .prepare(
      `SELECT
        id,
        workspace_id as workspaceId,
        kind,
        title,
        message,
        entity_path as entityPath,
        review_item_id as reviewItemId,
        created_at as createdAt
      FROM activity_events
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    )
    .all(workspaceId, limit) as ActivityEvent[];
}
