export function KnowledgeRoute({ rebuilding, onRebuild }: { rebuilding: boolean; onRebuild(): Promise<void> }) {
  return (
    <section className="route-panel" aria-labelledby="knowledge-heading">
      <div className="route-header">
        <h1 id="knowledge-heading">Knowledge</h1>
        <button type="button" disabled={rebuilding} onClick={() => void onRebuild()}>
          Rebuild Index
        </button>
      </div>
      {rebuilding ? <p className="inline-note">Index rebuilding...</p> : <p>Search English and Chinese notes.</p>}
    </section>
  );
}
