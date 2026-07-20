import { listActivity, recordActivity, type ActivityEvent, type AppDatabase } from "@kb-agent/storage";

export async function recordActivityEvent(db: AppDatabase, event: ActivityEvent): Promise<void> {
  await recordActivity(db, event);
}

export async function listRecentActivity(
  db: AppDatabase,
  workspaceId: string,
  limit = 50,
): Promise<ActivityEvent[]> {
  return listActivity(db, workspaceId, limit);
}
