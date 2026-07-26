export interface ActivityItem {
  id: string;
  title: string;
  message: string;
  kind: string;
}

export function ActivityFeed({ items, compact = false }: { items: ActivityItem[]; compact?: boolean }) {
  const content = (
    <>
      <div className="panel-header">
        <h2>Activity</h2>
      </div>
      {items.length === 0 ? (
        <p className="empty-state">No activity yet</p>
      ) : (
        <ol className="activity-list">
          {items.map((item) => (
            <li key={item.id}>
              <span className="activity-kind">{item.kind}</span>
              <strong>{item.title}</strong>
              <p>{item.message}</p>
            </li>
          ))}
        </ol>
      )}
    </>
  );

  if (compact) {
    return <div className="activity-feed-compact">{content}</div>;
  }

  return (
    <aside className="activity-panel" aria-label="Activity">
      {content}
    </aside>
  );
}
