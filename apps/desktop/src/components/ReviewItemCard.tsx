export interface ReviewCardItem {
  id: string;
  proposalType: string;
  risk: string;
  targetPath?: string;
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
  return (
    <article className="review-card">
      <div className="review-meta">
        <span>{item.proposalType}</span>
        <span>{item.risk}</span>
      </div>
      <h3>{item.targetPath ?? "New note proposal"}</h3>
      <p>{item.reason}</p>
      <div className="patch-preview">Structured patch preview</div>
      {item.failureReason ? <p className="error-text">{item.failureReason}</p> : null}
      <div className="button-row">
        <button type="button" onClick={() => void onApprove?.(item.id)}>
          Approve
        </button>
        <button type="button" className="secondary-button" onClick={() => void onReject?.(item.id)}>
          Reject
        </button>
      </div>
    </article>
  );
}
