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

export async function listReviewItems(
  db: AppDatabase,
  workspaceId: string,
  state: ReviewState | "all" = "all",
  limit = 50,
): Promise<ReviewItem[]> {
  const stateClause = state === "all" ? "" : "AND state = @state";
  const rows = db.sqlite
    .prepare(
      `SELECT
        id,
        workspace_id as workspaceId,
        state,
        risk,
        proposal_type as proposalType,
        target_path as targetPath,
        payload_json as payloadJson,
        reason,
        source_session_id as sourceSessionId,
        source_turn_id as sourceTurnId,
        created_at as createdAt,
        applied_at as appliedAt,
        superseded_by as supersededBy,
        failure_reason as failureReason
      FROM review_items
      WHERE workspace_id = @workspaceId ${stateClause}
      ORDER BY created_at DESC
      LIMIT @limit`,
    )
    .all({ workspaceId, state, limit }) as Array<ReviewItem & { payloadJson: string | null }>;

  return rows.map(({ payloadJson, ...row }) => {
    const item: ReviewItem = {
      id: row.id,
      workspaceId: row.workspaceId,
      state: row.state,
      risk: row.risk,
      proposalType: row.proposalType,
      payload: payloadJson ? JSON.parse(payloadJson) : null,
      reason: row.reason,
      sourceSessionId: row.sourceSessionId,
      sourceTurnId: row.sourceTurnId,
      createdAt: row.createdAt,
    };
    if (row.targetPath) {
      item.targetPath = row.targetPath;
    }
    if (row.appliedAt) {
      item.appliedAt = row.appliedAt;
    }
    if (row.supersededBy) {
      item.supersededBy = row.supersededBy;
    }
    if (row.failureReason) {
      item.failureReason = row.failureReason;
    }
    return item;
  });
}
