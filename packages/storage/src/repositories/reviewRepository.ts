import type { AppDatabase, ReviewItem, ReviewState } from "../types";

export async function createReviewItem(db: AppDatabase, item: ReviewItem): Promise<void> {
  db.sqlite
    .prepare(
      `INSERT INTO review_items (
        id, workspace_id, state, risk, proposal_type, target_path, payload_json,
        reason, source_session_id, source_turn_id, created_at, applied_at,
        superseded_by, failure_reason
      ) VALUES (
        @id, @workspaceId, @state, @risk, @proposalType, @targetPath, @payloadJson,
        @reason, @sourceSessionId, @sourceTurnId, @createdAt, @appliedAt,
        @supersededBy, @failureReason
      )`,
    )
    .run({
      ...item,
      targetPath: item.targetPath ?? null,
      payloadJson: JSON.stringify(item.payload),
      appliedAt: item.appliedAt ?? null,
      supersededBy: item.supersededBy ?? null,
      failureReason: item.failureReason ?? null,
    });
}

export async function transitionReviewItem(
  db: AppDatabase,
  id: string,
  from: ReviewState,
  to: ReviewState,
): Promise<void> {
  const result = db.sqlite
    .prepare("UPDATE review_items SET state = ? WHERE id = ? AND state = ?")
    .run(to, id, from);

  if (result.changes !== 1) {
    throw new Error("Invalid review transition");
  }
}
