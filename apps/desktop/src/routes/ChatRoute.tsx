import { useState, type FormEvent } from "react";

export type ChatTurnState = "idle" | "queued" | "streaming" | "tool-running" | "interrupted" | "failed" | "complete";

interface ChatSource {
  title: string;
  path: string;
  text?: string;
  snippet?: string;
  matchedFields?: string[];
}

type ChatMessage =
  | { role: "assistant" | "user" | "error"; content: string }
  | { role: "sources"; sources: ChatSource[] };

export function ChatRoute({
  messages,
  hasWorkspace,
  hasApiKey,
  turnState,
  onSend,
  onCancel,
}: {
  messages: ChatMessage[];
  hasWorkspace: boolean;
  hasApiKey: boolean;
  turnState: ChatTurnState;
  onSend(message: string): Promise<void>;
  onCancel(): Promise<void>;
}) {
  const [draft, setDraft] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message) {
      return;
    }

    setDraft("");
    await onSend(message);
  }

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
            {messages.map((message, index) =>
              message.role === "sources" ? (
                <section key={`sources-${index}`} className="source-evidence" aria-label="Sources used">
                  <h2>Sources used</h2>
                  <ul>
                    {message.sources.map((source) => (
                      <li key={`${source.path}-${source.title}`}>
                        <strong>{source.title}</strong>
                        <span>{source.path}</span>
                        <p>{source.snippet || source.text || "No preview available."}</p>
                        {source.matchedFields?.length ? <small>Matched fields: {source.matchedFields.join(", ")}</small> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : (
                <p
                  key={`${message.role}-${index}`}
                  className={message.role === "user" ? "user-message" : message.role === "error" ? "error-message" : "assistant-message"}
                >
                  {message.content}
                </p>
              ),
            )}
          </div>
          <form className="composer" onSubmit={submit}>
            <input
              aria-label="Message"
              disabled={!hasWorkspace}
              placeholder="Ask about local knowledge"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" disabled={!hasWorkspace}>
              Send
            </button>
            <button type="button" className="secondary-button" onClick={onCancel}>
              Cancel
            </button>
          </form>
        </>
      )}
    </section>
  );
}
