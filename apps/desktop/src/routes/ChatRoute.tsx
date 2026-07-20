export type ChatTurnState = "idle" | "queued" | "streaming" | "tool-running" | "interrupted" | "failed" | "complete";

export function ChatRoute({
  hasWorkspace,
  hasApiKey,
  turnState,
}: {
  hasWorkspace: boolean;
  hasApiKey: boolean;
  turnState: ChatTurnState;
}) {
  return (
    <section className="route-panel" aria-labelledby="chat-heading">
      <div className="route-header">
        <h1 id="chat-heading">Chat</h1>
        <span className="status-pill">{turnState}</span>
      </div>
      {!hasWorkspace ? (
        <div className="empty-box">Create a workspace to start chatting.</div>
      ) : (
        <>
          {!hasApiKey ? <p className="inline-note">Mock provider active until an API key is saved.</p> : null}
          <div className="transcript">
            <p className="assistant-message">Ask about your notes or propose a safe knowledge update.</p>
          </div>
          <form className="composer">
            <input aria-label="Message" disabled={!hasWorkspace} placeholder="Ask about local knowledge" />
            <button type="submit" disabled={!hasWorkspace}>
              Send
            </button>
            <button type="button" className="secondary-button">
              Cancel
            </button>
          </form>
        </>
      )}
    </section>
  );
}
