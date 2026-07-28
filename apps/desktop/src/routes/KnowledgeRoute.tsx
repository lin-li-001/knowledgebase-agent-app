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

export function KnowledgeRoute({
  rebuilding,
  auditing,
  importDisabled,
  auditResult,
  importNotices,
  onRebuild,
  onAudit,
  onImport,
}: {
  rebuilding: boolean;
  auditing: boolean;
  importDisabled: boolean;
  auditResult?: WorkspaceAuditResult | null;
  importNotices: string[];
  onRebuild(): Promise<void>;
  onAudit(): Promise<void>;
  onImport(input: { batchName: string; filePaths: string[] }): Promise<void>;
}) {
  return (
    <section className="route-panel" aria-labelledby="knowledge-heading">
      <div className="route-header">
        <h1 id="knowledge-heading">Knowledge</h1>
        <button type="button" disabled={rebuilding} onClick={() => void onRebuild()}>
          Rebuild Index
        </button>
        <button type="button" className="secondary-button" disabled={auditing || importDisabled} onClick={() => void onAudit()}>
          Run Audit
        </button>
      </div>
      {rebuilding ? <p className="inline-note">Index rebuilding...</p> : <p>Search English and Chinese notes.</p>}
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
