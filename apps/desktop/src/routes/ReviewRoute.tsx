import { ReviewItemCard, type ReviewCardItem } from "../components/ReviewItemCard";

export function ReviewRoute({ items }: { items: ReviewCardItem[] }) {
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
            <ReviewItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
