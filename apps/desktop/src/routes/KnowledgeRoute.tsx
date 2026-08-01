import { ImportDropzone } from "../components/ImportDropzone";

export interface WorkspaceAuditFinding {
  code: string;
  severity: string;
  path: string;
  message: string;
}

export interface WorkspaceAuditResult {
  status: string;
  findings: WorkspaceAuditFinding[];
}

export interface EmbeddingStatus {
  ollama: {
    available: boolean;
    model: string;
    modelInstalled: boolean;
    error?: string;
  };
  lastIndex: {
    vectorIndexing: "not_configured" | "completed" | "failed";
    vectorError?: string;
    noteCount: number;
    chunkCount: number;
  } | null;
}

export function KnowledgeRoute({
  rebuilding,
  auditing,
  importDisabled,
  auditResult,
  importNotices,
  embeddingStatus,
  onRebuild,
  onAudit,
  onImport,
}: {
  rebuilding: boolean;
  auditing: boolean;
  importDisabled: boolean;
  auditResult?: WorkspaceAuditResult | null;
  importNotices: string[];
  embeddingStatus?: EmbeddingStatus | null;
  onRebuild(): Promise<void>;
  onAudit(): Promise<void>;
  onImport(input: { batchName: string; filePaths: string[] }): Promise<void>;
}) {
  return (
    <section className="route-panel" aria-labelledby="knowledge-heading">
      <div className="route-header">
        <h1 id="knowledge-heading">Knowledge</h1>
        <button type="button" disabled={rebuilding} onClick={() => void onRebuild()}>
          {embeddingStatus?.lastIndex?.vectorIndexing === "failed" ? "Retry Vector Index" : "Rebuild Index"}
        </button>
        <button type="button" className="secondary-button" disabled={auditing || importDisabled} onClick={() => void onAudit()}>
          Run Audit
        </button>
      </div>
      {rebuilding ? <p className="inline-note">Index rebuilding...</p> : <p>Search English and Chinese notes.</p>}
      {embeddingStatus ? <EmbeddingStatusPanel status={embeddingStatus} /> : null}
      {auditing ? <p className="inline-note">Workspace audit running...</p> : null}
      {auditResult ? (
        <section className="audit-panel" aria-label="Workspace audit results">
          <h2>Workspace audit: {auditResult.status}</h2>
          {auditResult.findings.length ? (
            <ul className="audit-list">
              {auditResult.findings.map((finding, index) => (
                <li key={`${finding.code}-${finding.path}-${index}`}>
                  <strong>{finding.code}</strong>
                  <span>{finding.severity}</span>
                  <code>{finding.path}</code>
                  <p>{finding.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p>No findings.</p>
          )}
        </section>
      ) : null}
      {importNotices.length ? (
        <ul className="import-results" aria-label="Import results">
          {importNotices.map((notice) => <li key={notice}>{notice}</li>)}
        </ul>
      ) : null}
      <ImportDropzone disabled={importDisabled} onImport={onImport} />
    </section>
  );
}

function EmbeddingStatusPanel({ status }: { status: EmbeddingStatus }) {
  const indexStatus = status.lastIndex?.vectorIndexing ?? "not_configured";
  const ollamaLabel = !status.ollama.available
    ? "Ollama unavailable"
    : status.ollama.modelInstalled
      ? `${status.ollama.model} ready`
      : `${status.ollama.model} not installed`;
  return (
    <section className="embedding-status" aria-label="Embedding status">
      <strong>Semantic index</strong>
      <span>{ollamaLabel}</span>
      <span>Index: {indexStatus}</span>
      {!status.ollama.available && status.ollama.error ? <small>{status.ollama.error}</small> : null}
      {status.ollama.available && !status.ollama.modelInstalled ? <small>Install the configured model in Ollama, then rebuild the index.</small> : null}
      {status.lastIndex?.vectorError ? <small>{status.lastIndex.vectorError}</small> : null}
    </section>
  );
}
