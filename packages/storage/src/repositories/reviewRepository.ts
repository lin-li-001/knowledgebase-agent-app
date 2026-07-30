import type { AppDatabase, ReviewItem, ReviewState } from "../types";

export async function createReviewItem(db: AppDatabase, item: ReviewItem): Promise<void> {
  db.sqlite
    .prepare(
      `INSERT INTO review_items (
        id, workspace_id, state, risk, proposal_type, target_path, payload_json,
        reason, source_session_id, source_turn_id, created_at, applied_at,
        superseded_by, failure_reason, claim_token, claim_started_at, application_json
      ) VALUES (
        @id, @workspaceId, @state, @risk, @proposalType, @targetPath, @payloadJson,
        @reason, @sourceSessionId, @sourceTurnId, @createdAt, @appliedAt,
        @supersededBy, @failureReason, @claimToken, @claimStartedAt, @applicationJson
      )`,
    )
    .run({
      ...item,
      targetPath: item.targetPath ?? null,
      payloadJson: JSON.stringify(item.payload),
      appliedAt: item.appliedAt ?? null,
      supersededBy: item.supersededBy ?? null,
      failureReason: item.failureReason ?? null,
      claimToken: item.claimToken ?? null,
      claimStartedAt: item.claimStartedAt ?? null,
      applicationJson: item.application === undefined ? null : JSON.stringify(item.application),
    });
}

export async function claimReviewItem(
  db: AppDatabase,
  id: string,
  claim: {
    from: ReviewState[];
    to: "applying" | "rejecting";
    token: string;
    startedAt: string;
    application?: unknown;
    staleBefore?: string;
    staleClaimToken?: string;
  },
): Promise<boolean> {
  if (claim.from.length === 0) {
    return false;
  }
  const placeholders = claim.from.map(() => "?").join(", ");
  const staleClause = claim.staleBefore && claim.staleClaimToken
    ? " OR (state = ? AND claim_token = ? AND claim_started_at < ?)"
    : "";
  const result = db.sqlite
    .prepare(
      `UPDATE review_items
       SET state = ?, claim_token = ?, claim_started_at = ?, application_json = ?,
           failure_reason = NULL
       WHERE id = ? AND (state IN (${placeholders})${staleClause})`,
    )
    .run(
      claim.to,
      claim.token,
      claim.startedAt,
      claim.application === undefined ? null : JSON.stringify(claim.application),
      id,
      ...claim.from,
      ...(claim.staleBefore && claim.staleClaimToken
        ? [claim.to, claim.staleClaimToken, claim.staleBefore]
        : []),
    );
  return result.changes === 1;
}

export async function updateReviewItemApplication(
  db: AppDatabase,
  id: string,
  claimToken: string,
  application: unknown,
): Promise<void> {
  const result = db.sqlite
    .prepare(
      "UPDATE review_items SET application_json = ? WHERE id = ? AND state = 'applying' AND claim_token = ?",
    )
    .run(JSON.stringify(application), id, claimToken);
  if (result.changes !== 1) {
    throw new Error("Review application claim was lost");
  }
}

export async function updateReviewItemPayload(
  db: AppDatabase,
  id: string,
  claimToken: string,
  payload: unknown,
): Promise<void> {
  const result = db.sqlite
    .prepare(
      "UPDATE review_items SET payload_json = ? WHERE id = ? AND state = 'applying' AND claim_token = ?",
    )
    .run(JSON.stringify(payload), id, claimToken);
  if (result.changes !== 1) {
    throw new Error("Review application claim was lost");
  }
}

export async function transitionReviewItem(
  db: AppDatabase,
  id: string,
  from: ReviewState,
  to: ReviewState,
  options: { appliedAt?: string; failureReason?: string | null } = {},
): Promise<void> {
  if (from === "applying" || from === "rejecting") {
    throw new Error("Claimed review transitions require a claim token");
  }
  const result = db.sqlite
    .prepare(
      `UPDATE review_items
       SET state = ?, applied_at = ?, failure_reason = ?, claim_token = NULL, claim_started_at = NULL
       WHERE id = ? AND state = ?`,
    )
    .run(to, options.appliedAt ?? null, options.failureReason ?? null, id, from);

  if (result.changes !== 1) {
    throw new Error("Invalid review transition");
  }
}

export async function transitionClaimedReviewItem(
  db: AppDatabase,
  id: string,
  from: "applying" | "rejecting",
  to: ReviewState,
  claimToken: string,
  options: { appliedAt?: string; failureReason?: string | null } = {},
): Promise<void> {
  const result = db.sqlite
    .prepare(
      `UPDATE review_items
       SET state = ?, applied_at = ?, failure_reason = ?, claim_token = NULL, claim_started_at = NULL
       WHERE id = ? AND state = ? AND claim_token = ?`,
    )
    .run(to, options.appliedAt ?? null, options.failureReason ?? null, id, from, claimToken);
  if (result.changes !== 1) {
    throw new Error("Review claim was lost");
  }
}

export async function renewReviewItemClaim(
  db: AppDatabase,
  id: string,
  state: "applying" | "rejecting",
  claimToken: string,
  startedAt: string,
): Promise<boolean> {
  const result = db.sqlite
    .prepare(
      "UPDATE review_items SET claim_started_at = ? WHERE id = ? AND state = ? AND claim_token = ?",
    )
    .run(startedAt, id, state, claimToken);
  return result.changes === 1;
}

export async function expireReviewItemClaims(
  db: AppDatabase,
  workspaceId: string,
  staleBefore: string,
): Promise<number> {
  const result = db.sqlite
    .prepare(
      `UPDATE review_items
       SET state = 'failed',
           failure_reason = CASE state
             WHEN 'applying' THEN 'Previous applying lease expired; retry is available.'
             ELSE 'Previous rejecting lease expired; retry is available.'
           END,
           claim_token = NULL,
           claim_started_at = NULL
       WHERE workspace_id = ?
         AND state IN ('applying', 'rejecting')
         AND (claim_started_at IS NULL OR claim_started_at < ?)`,
    )
    .run(workspaceId, staleBefore);
  return result.changes;
}

export async function getReviewItemState(db: AppDatabase, id: string): Promise<ReviewState | null> {
  const row = db.sqlite
    .prepare("SELECT state FROM review_items WHERE id = ?")
    .get(id) as { state: ReviewState } | undefined;

  return row?.state ?? null;
}

export async function getReviewItem(db: AppDatabase, id: string): Promise<ReviewItem | null> {
  const row = db.sqlite
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
        failure_reason as failureReason,
        claim_token as claimToken,
        claim_started_at as claimStartedAt,
        application_json as applicationJson
      FROM review_items
      WHERE id = ?`,
    )
    .get(id) as (ReviewItem & { payloadJson: string | null; applicationJson: string | null }) | undefined;

  return row ? parseReviewRow(row) : null;
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
        failure_reason as failureReason,
        claim_token as claimToken,
        claim_started_at as claimStartedAt,
        application_json as applicationJson
      FROM review_items
      WHERE workspace_id = @workspaceId ${stateClause}
      ORDER BY created_at DESC
      LIMIT @limit`,
    )
    .all({ workspaceId, state, limit }) as Array<ReviewItem & { payloadJson: string | null; applicationJson: string | null }>;

  return rows.map(parseReviewRow);
}

function parseReviewRow(
  { payloadJson, applicationJson, ...row }: ReviewItem & {
    payloadJson: string | null;
    applicationJson: string | null;
  },
): ReviewItem {
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
  if (row.claimToken) {
    item.claimToken = row.claimToken;
  }
  if (row.claimStartedAt) {
    item.claimStartedAt = row.claimStartedAt;
  }
  if (applicationJson) {
    item.application = JSON.parse(applicationJson);
  }
  return item;
}
