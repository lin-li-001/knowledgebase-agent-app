import { useEffect, useRef, useState } from "react";
import type { ContentCategory, ContentCategoryDefinition } from "@kb-agent/workspace";
import { categoryDefinitionFallback, initialCategoryFallback } from "../state/categoryCatalog";

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
  application?: unknown;
}

export interface ReviewApprovalOptions {
  categoryOverride?: ContentCategory;
  targetPathOverride?: string;
  saveAsRoutingRule?: boolean;
  routingRulePattern?: string;
}

export function ReviewItemCard({
  item,
  activeCategories = initialCategoryFallback,
  categories = initialCategoryFallback,
  onApprove,
  onReject,
}: {
  item: ReviewCardItem;
  activeCategories?: ContentCategoryDefinition[];
  categories?: ContentCategoryDefinition[];
  onApprove?(id: string, options?: ReviewApprovalOptions): Promise<void>;
  onReject?(id: string): Promise<void>;
}) {
  const canApprove = item.state === undefined || item.state === "proposed" || item.state === "approved" || item.state === "failed";
  const hasApplicationIntent = item.application !== undefined && item.application !== null;
  const canReject = !hasApplicationIntent
    && (item.state === undefined || item.state === "proposed" || item.state === "failed");
  const offersApprovalRecovery = hasApplicationIntent && canApprove;
  const source = reviewSource(item);
  const proposedDestination = destinationPath(item);
  const persistedApplication = persistedApplicationView(item.application);
  const editableDestination = persistedApplication.destination
    ?? persistedApplication.options.targetPathOverride
    ?? proposedDestination;
  const importDetails = importReviewDetails(item);
  const [destination, setDestination] = useState(editableDestination ?? "");
  const [category, setCategory] = useState<ContentCategory | undefined>(
    persistedApplication.options.categoryOverride ?? importDetails?.category,
  );
  const categoryOptions = reviewCategoryOptions(
    activeCategories,
    categories,
    importDetails?.category,
    category,
  );
  const [saveAsRoutingRule, setSaveAsRoutingRule] = useState(
    persistedApplication.options.saveAsRoutingRule ?? false,
  );
  const [routingRulePattern, setRoutingRulePattern] = useState(
    persistedApplication.options.routingRulePattern ?? "",
  );
  const applicationVersion = reviewApplicationVersion(item);
  const renderedApplicationVersion = useRef(applicationVersion);
  const [requestPending, setRequestPending] = useState(false);
  const requestInFlight = useRef(false);

  useEffect(() => {
    if (renderedApplicationVersion.current === applicationVersion) {
      return;
    }
    renderedApplicationVersion.current = applicationVersion;
    setDestination(editableDestination ?? "");
    setCategory(
      persistedApplication.options.categoryOverride ?? importDetails?.category,
    );
    setSaveAsRoutingRule(
      persistedApplication.options.saveAsRoutingRule ?? false,
    );
    setRoutingRulePattern(
      persistedApplication.options.routingRulePattern ?? "",
    );
  }, [
    applicationVersion,
    editableDestination,
    importDetails?.category,
    persistedApplication.options.categoryOverride,
    persistedApplication.options.routingRulePattern,
    persistedApplication.options.saveAsRoutingRule,
  ]);

  async function approve() {
    if (!onApprove || requestInFlight.current) {
      return;
    }

    const options: ReviewApprovalOptions = {};
    if (
      importDetails
      && category
      && (
        category !== importDetails.category
        || hasApplicationIntent
      )
    ) {
      options.categoryOverride = category;
    }
    if (editableDestination) {
      const trimmedDestination = destination.trim();
      if (
        trimmedDestination
        && (
          trimmedDestination !== proposedDestination
          || hasApplicationIntent
        )
      ) {
        options.targetPathOverride = trimmedDestination;
      }
    }
    if (saveAsRoutingRule) {
      const trimmedPattern = routingRulePattern.trim();
      options.saveAsRoutingRule = true;
      if (trimmedPattern) {
        options.routingRulePattern = trimmedPattern;
      }
    }

    await runReviewRequest(() => onApprove(item.id, Object.keys(options).length ? options : undefined));
  }

  async function reject() {
    if (!onReject || requestInFlight.current) {
      return;
    }

    await runReviewRequest(() => onReject(item.id));
  }

  async function runReviewRequest(request: () => Promise<void>) {
    requestInFlight.current = true;
    setRequestPending(true);
    try {
      await request();
    } catch {
      // The app-level handler reports the failed request; the card remains retryable.
    } finally {
      requestInFlight.current = false;
      setRequestPending(false);
    }
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
      {importDetails ? (
        <div className="review-classification">
          <ul aria-label="Import classification">
            <li>Category: {importDetails.category}</li>
            <li>Sensitivity: {importDetails.sensitivity}</li>
            <li>Confidence: {importDetails.confidence}</li>
            {importDetails.evidence.map((evidence) => <li key={evidence}>Evidence: {evidence}</li>)}
            {importDetails.reasonCodes.map((reasonCode) => <li key={reasonCode}>Reasons: {reasonCode}</li>)}
          </ul>
        </div>
      ) : null}
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
          {importDetails ? (
            <label>
              Category
              <select value={category} onChange={(event) => setCategory(event.currentTarget.value as ContentCategory)}>
                {categoryOptions.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label} ({candidate.id}){candidate.proposed ? " - new" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Destination
            <input
              aria-describedby="review-destination-help"
              value={destination}
              onChange={(event) => setDestination(event.currentTarget.value)}
            />
          </label>
          <small id="review-destination-help">Enter the complete Markdown file path, including `.md`.</small>
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
      {offersApprovalRecovery ? (
        <p className="review-recovery">
          This approval is already prepared. Resume approval to reconcile its recorded destination.
        </p>
      ) : null}
      <div className="button-row">
        <button type="button" disabled={requestPending || !canApprove} onClick={() => void approve()}>
          {offersApprovalRecovery ? "Resume approval" : "Approve"}
        </button>
        {!hasApplicationIntent ? (
          <button type="button" className="secondary-button" disabled={requestPending || !canReject} onClick={() => void reject()}>
            Reject
          </button>
        ) : null}
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

function persistedApplicationView(application: unknown): {
  destination?: string;
  options: ReviewApprovalOptions;
} {
  if (!isRecord(application)) {
    return { options: {} };
  }
  const options = isRecord(application.options)
    ? persistedApprovalOptions(application.options)
    : {};
  return {
    ...(typeof application.destination === "string"
      && application.destination.trim() !== ""
      ? { destination: application.destination }
      : {}),
    options,
  };
}

function persistedApprovalOptions(
  value: Record<string, unknown>,
): ReviewApprovalOptions {
  return {
    ...(isContentCategory(value.categoryOverride)
      ? { categoryOverride: value.categoryOverride }
      : {}),
    ...(typeof value.targetPathOverride === "string"
      ? { targetPathOverride: value.targetPathOverride }
      : {}),
    ...(typeof value.saveAsRoutingRule === "boolean"
      ? { saveAsRoutingRule: value.saveAsRoutingRule }
      : {}),
    ...(typeof value.routingRulePattern === "string"
      ? { routingRulePattern: value.routingRulePattern }
      : {}),
  };
}

function reviewApplicationVersion(item: ReviewCardItem): string {
  return `${item.id}:${stableValueSignature(item.application)}`;
}

function stableValueSignature(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableValueSignature).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValueSignature(
      (value as Record<string, unknown>)[key],
    )}`)
    .join(",")}}`;
}

function reviewTitle(item: ReviewCardItem): string {
  if (item.proposalType === "propose_memory") {
    return "Memory proposal";
  }
  if (item.proposalType === "propose_annotation") {
    return "Source annotation proposal";
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
  if (item.proposalType === "propose_annotation") {
    return "Annotation to append";
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
    if (
      "sourceNotePath" in payload
      && typeof payload.sourceNotePath === "string"
      && payload.sourceNotePath.startsWith(".app/import-staging/")
    ) {
      return "Staged note content is unavailable.";
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

function importReviewDetails(item: ReviewCardItem): {
  category: ContentCategory;
  sensitivity: string;
  confidence: string;
  evidence: string[];
  reasonCodes: string[];
} | null {
  const payload = item.payload;
  if (!isRecord(payload) || !isRecord(payload.classification) || !isRecord(payload.safetyDecision)) {
    return null;
  }

  const category = payload.classification.primaryCategory;
  const sensitivity = payload.classification.sensitivity;
  const confidence = payload.classification.confidence;
  const evidence = payload.classification.evidence;
  const reasonCodes = payload.safetyDecision.reasonCodes;
  if (
    !isContentCategory(category)
    || typeof sensitivity !== "string"
    || typeof confidence !== "number"
    || !Array.isArray(evidence)
    || !evidence.every((value) => typeof value === "string")
    || !Array.isArray(reasonCodes)
    || !reasonCodes.every((value) => typeof value === "string")
  ) {
    return null;
  }

  return {
    category,
    sensitivity,
    confidence: String(confidence),
    evidence,
    reasonCodes,
  };
}

function isContentCategory(value: unknown): value is ContentCategory {
  return typeof value === "string"
    && value.length <= 120
    && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u.test(value);
}

function reviewCategoryOptions(
  activeCategories: ContentCategoryDefinition[],
  categories: ContentCategoryDefinition[],
  proposedCategory: ContentCategory | undefined,
  selectedCategory: ContentCategory | undefined,
): Array<ContentCategoryDefinition & { proposed: boolean }> {
  const activeIds = new Set(activeCategories.map((category) => category.id));
  const options = activeCategories.map((category) => ({ ...category, proposed: false }));
  for (const candidateId of [proposedCategory, selectedCategory]) {
    if (!candidateId || activeIds.has(candidateId)) {
      continue;
    }
    const candidate = categories.find((category) => category.id === candidateId)
      ?? categoryDefinitionFallback(candidateId);
    options.push({ ...candidate, proposed: true });
    activeIds.add(candidateId);
  }
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
