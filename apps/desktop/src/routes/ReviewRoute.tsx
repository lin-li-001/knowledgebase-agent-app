import { ReviewItemCard, type ReviewApprovalOptions, type ReviewCardItem } from "../components/ReviewItemCard";

export function ReviewRoute({
  items,
  onApprove,
  onReject,
}: {
  items: ReviewCardItem[];
  onApprove(id: string, options?: ReviewApprovalOptions): Promise<void>;
  onReject(id: string): Promise<void>;
}) {
  return (
    <section className="route-panel" aria-labelledby="review-heading">
      <div className="route-header">
        <h1 id="review-heading">Review</h1>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">No review items</p>
      ) : (
        <div className="review-list">
          {items.map((item) => (
            <ReviewItemCard key={item.id} item={item} onApprove={onApprove} onReject={onReject} />
          ))}
        </div>
      )}
    </section>
  );
}
