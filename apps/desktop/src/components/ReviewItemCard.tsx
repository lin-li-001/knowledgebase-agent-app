import { useState } from "react";

export interface ReviewCardItem {
  id: string;
  state?: string;
  proposalType: string;
  risk: string;
  targetPath?: string;
  payload?: unknown;
  reason: string;
  sourceSessionId?: string;
  sourceTurnId?: string;
  failureReason?: string;
}

export interface ReviewApprovalOptions {
  targetPathOverride?: string;
  saveAsRoutingRule?: boolean;
  routingRulePattern?: string;
}

export function ReviewItemCard({
  item,
  onApprove,
  onReject,
}: {
  item: ReviewCardItem;
  onApprove?(id: string, options?: ReviewApprovalOptions): Promise<void>;
  onReject?(id: string): Promise<void>;
}) {
  const canApprove = item.state === undefined || item.state === "proposed" || item.state === "approved";
  const canReject = item.state === undefined || item.state === "proposed";
  const source = reviewSource(item);
  const editableDestination = destinationPath(item);
  const [destination, setDestination] = useState(editableDestination ?? "");
  const [saveAsRoutingRule, setSaveAsRoutingRule] = useState(false);
  const [routingRulePattern, setRoutingRulePattern] = useState("");

  function approve() {
    if (!editableDestination) {
      void onApprove?.(item.id);
      return;
    }

    const trimmedDestination = destination.trim();
    const trimmedPattern = routingRulePattern.trim();
    const options: ReviewApprovalOptions = {};
    if (trimmedDestination && trimmedDestination !== editableDestination) {
      options.targetPathOverride = trimmedDestination;
    }
    if (saveAsRoutingRule) {
      options.saveAsRoutingRule = true;
      if (trimmedPattern) {
        options.routingRulePattern = trimmedPattern;
      }
    }

    void onApprove?.(item.id, Object.keys(options).length ? options : undefined);
  }

  return (
    <article className="review-card">
      <div className="review-meta">
        <span>{item.proposalType}</span>
        <span>{item.risk}</span>
        {item.state ? <span>{item.state}</span> : null}
      </div>
      <h3>{reviewTitle(item)}</h3>
      <p>{item.reason}</p>
      {item.sourceSessionId && item.sourceTurnId ? (
        <p className="review-source">From session {item.sourceSessionId}, turn {item.sourceTurnId}</p>
      ) : null}
      <div className="patch-preview">
        <strong>{previewLabel(item)}</strong>
        <pre>{previewText(item)}</pre>
      </div>
      {source ? (
        <div className="review-context">
          <strong>Why this was proposed</strong>
          {source.reason ? <p>{source.reason}</p> : null}
          {source.userMessage ? (
            <>
              <span>User message</span>
              <p>{source.userMessage}</p>
            </>
          ) : null}
          {source.assistantMessage ? (
            <>
              <span>Assistant message</span>
              <p>{source.assistantMessage}</p>
            </>
          ) : null}
        </div>
      ) : null}
      {editableDestination ? (
        <div className="routing-review">
          <label>
            Destination
            <input value={destination} onChange={(event) => setDestination(event.currentTarget.value)} />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={saveAsRoutingRule}
              onChange={(event) => setSaveAsRoutingRule(event.currentTarget.checked)}
            />
            Save as future routing rule
          </label>
          {saveAsRoutingRule ? (
            <label>
              Routing rule pattern
              <input
                placeholder="utility bills"
                value={routingRulePattern}
                onChange={(event) => setRoutingRulePattern(event.currentTarget.value)}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      {item.failureReason ? <p className="error-text">{item.failureReason}</p> : null}
      <div className="button-row">
        <button type="button" disabled={!canApprove} onClick={approve}>
          Approve
        </button>
        <button type="button" className="secondary-button" disabled={!canReject} onClick={() => void onReject?.(item.id)}>
          Reject
        </button>
      </div>
    </article>
  );
}

function destinationPath(item: ReviewCardItem): string | null {
  if (item.proposalType !== "propose_create_note" && item.proposalType !== "propose_decision") {
    return null;
  }
  if (item.targetPath) {
    return item.targetPath;
  }

  const payload = item.payload;
  if (typeof payload === "object" && payload !== null && "path" in payload && typeof payload.path === "string") {
    return payload.path;
  }
  return null;
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

function reviewSource(item: ReviewCardItem): { reason?: string; userMessage?: string; assistantMessage?: string } | null {
  const payload = item.payload;
  if (typeof payload !== "object" || payload === null || !("source" in payload)) {
    return null;
  }

  const source = payload.source;
  if (typeof source !== "object" || source === null) {
    return null;
  }

  const result: { reason?: string; userMessage?: string; assistantMessage?: string } = {};
  const reason = stringField(source, "reason");
  const userMessage = stringField(source, "userMessage");
  const assistantMessage = stringField(source, "assistantMessage");
  if (reason) {
    result.reason = reason;
  }
  if (userMessage) {
    result.userMessage = userMessage;
  }
  if (assistantMessage) {
    result.assistantMessage = assistantMessage;
  }
  return result;
}

function stringField(source: object, key: string): string | undefined {
  return key in source && typeof source[key as keyof typeof source] === "string"
    ? source[key as keyof typeof source]
    : undefined;
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
