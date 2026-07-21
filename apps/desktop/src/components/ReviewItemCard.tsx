export interface ReviewCardItem {
  id: string;
  state?: string;
  proposalType: string;
  risk: string;
  targetPath?: string;
  payload?: unknown;
  reason: string;
  failureReason?: string;
}

export function ReviewItemCard({
  item,
  onApprove,
  onReject,
}: {
  item: ReviewCardItem;
  onApprove?(id: string): Promise<void>;
  onReject?(id: string): Promise<void>;
}) {
  const canReview = item.state === undefined || item.state === "proposed";

  return (
    <article className="review-card">
      <div className="review-meta">
        <span>{item.proposalType}</span>
        <span>{item.risk}</span>
        {item.state ? <span>{item.state}</span> : null}
      </div>
      <h3>{reviewTitle(item)}</h3>
      <p>{item.reason}</p>
      <div className="patch-preview">
        <strong>{previewLabel(item)}</strong>
        <pre>{previewText(item)}</pre>
      </div>
      {item.failureReason ? <p className="error-text">{item.failureReason}</p> : null}
      <div className="button-row">
        <button type="button" disabled={!canReview} onClick={() => void onApprove?.(item.id)}>
          Approve
        </button>
        <button type="button" className="secondary-button" disabled={!canReview} onClick={() => void onReject?.(item.id)}>
          Reject
        </button>
      </div>
    </article>
  );
}

function reviewTitle(item: ReviewCardItem): string {
  if (item.proposalType === "propose_memory") {
    return "Memory proposal";
  }

  return item.targetPath ?? "New note proposal";
}

function previewLabel(item: ReviewCardItem): string {
  if (item.proposalType === "propose_memory") {
    return "Memory to save";
  }
  if (item.proposalType === "propose_delete") {
    return "Delete request";
  }
  if (item.proposalType === "propose_create_note") {
    return "Note content";
  }
  if (item.proposalType === "propose_update_note") {
    return "Patch";
  }

  return "Payload";
}

function previewText(item: ReviewCardItem): string {
  const payload = item.payload;
  if (typeof payload === "object" && payload !== null) {
    if ("body" in payload && typeof payload.body === "string") {
      return payload.body;
    }
    if ("patch" in payload) {
      return formatPayload(payload.patch);
    }
  }

  return formatPayload(payload);
}

function formatPayload(payload: unknown): string {
  if (payload === undefined || payload === null) {
    return "No structured payload.";
  }
  if (typeof payload === "string") {
    return payload;
  }

  return JSON.stringify(payload, null, 2);
}
