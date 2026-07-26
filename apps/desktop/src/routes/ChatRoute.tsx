import { Fragment, useState, type FormEvent, type ReactNode } from "react";

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
                <MessageBubble key={`${message.role}-${index}`} message={message} />
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

function MessageBubble({ message }: { message: Exclude<ChatMessage, { role: "sources" }> }) {
  if (message.role === "assistant") {
    return (
      <div className="assistant-message assistant-markdown">
        <MarkdownBlocks content={message.content} />
      </div>
    );
  }

  return (
    <p className={message.role === "user" ? "user-message" : "error-message"}>
      {message.content}
    </p>
  );
}

function MarkdownBlocks({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeFence = line.match(/^```(\w+)?\s*$/);
    if (codeFence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={`code-${index}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      const level = (heading[1] ?? "##").length;
      const text = heading[2] ?? "";
      blocks.push(level === 2 ? <h2 key={`heading-${index}`}>{renderInline(text)}</h2> : <h3 key={`heading-${index}`}>{renderInline(text)}</h3>);
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`list-${index}`}>
          {items.map((item, itemIndex) => <li key={`${item}-${itemIndex}`}>{renderInline(item)}</li>)}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol key={`ordered-${index}`}>
          {items.map((item, itemIndex) => <li key={`${item}-${itemIndex}`}>{renderInline(item)}</li>)}
        </ol>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]?.trim() &&
      !/^```/.test(lines[index] ?? "") &&
      !/^(#{2,4})\s+/.test(lines[index] ?? "") &&
      !/^[-*]\s+/.test(lines[index] ?? "") &&
      !/^\d+\.\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`}>{renderInline(paragraph.join(" "))}</p>);
  }

  return <>{blocks}</>;
}

function renderInline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={`${part}-${index}`}>{part}</Fragment>;
  });
}
