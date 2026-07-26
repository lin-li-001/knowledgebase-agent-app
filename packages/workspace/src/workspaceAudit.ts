import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AppDatabase } from "@kb-agent/storage";
import { parseMarkdownNote } from "./markdown";
import { defaultRoutingPolicy } from "./routingPolicy";
import { workspaceIdForRoot } from "./indexer";

export type WorkspaceAuditStatus = "pass" | "warning" | "fail";
export type WorkspaceAuditSeverity = "info" | "warning" | "error";

export interface WorkspaceAuditInput {
  rootPath: string;
  db?: AppDatabase;
}

export interface WorkspaceAuditFinding {
  code:
    | "missing_frontmatter"
    | "attachment_without_summary"
    | "import_summary_not_indexed"
    | "note_not_indexed"
    | "note_index_stale"
    | "agents_drift"
    | "routing_drift";
  severity: WorkspaceAuditSeverity;
  path: string;
  message: string;
}

export interface WorkspaceAuditResult {
  status: WorkspaceAuditStatus;
  findings: WorkspaceAuditFinding[];
}

export async function auditWorkspace(input: WorkspaceAuditInput): Promise<WorkspaceAuditResult> {
  const rootPath = path.resolve(input.rootPath);
  const findings: WorkspaceAuditFinding[] = [];

  await auditMarkdownFrontmatter(rootPath, findings);
  await auditImportBatches(rootPath, input.db, findings);
  await auditIndexFreshness(rootPath, input.db, findings);
  await auditWorkspaceContract(rootPath, findings);

  return {
    status: auditStatus(findings),
    findings,
  };
}

async function auditIndexFreshness(rootPath: string, db: AppDatabase | undefined, findings: WorkspaceAuditFinding[]): Promise<void> {
  if (!db) {
    return;
  }

  const workspaceId = workspaceIdForRoot(rootPath);
  const markdownPaths = await collectAuditableMarkdownFiles(rootPath);
  for (const absolutePath of markdownPaths) {
    let parsed;
    try {
      parsed = await parseMarkdownNote(absolutePath);
    } catch {
      continue;
    }

    const relativePath = path.relative(rootPath, absolutePath);
    const row = db.sqlite
      .prepare("SELECT content_hash as contentHash FROM notes WHERE workspace_id = ? AND path = ? LIMIT 1")
      .get(workspaceId, relativePath) as { contentHash: string } | undefined;
    if (!row) {
      findings.push({
        code: "note_not_indexed",
        severity: "warning",
        path: relativePath,
        message: "Note exists on disk but is not present in the SQLite index.",
      });
      continue;
    }
    if (row.contentHash !== parsed.contentHash) {
      findings.push({
        code: "note_index_stale",
        severity: "warning",
        path: relativePath,
        message: "Note content has changed since the SQLite index was built.",
      });
    }
  }
}

async function auditMarkdownFrontmatter(rootPath: string, findings: WorkspaceAuditFinding[]): Promise<void> {
  const markdownPaths = await collectAuditableMarkdownFiles(rootPath);
  for (const absolutePath of markdownPaths) {
    try {
      await parseMarkdownNote(absolutePath);
    } catch (error) {
      const relativePath = path.relative(rootPath, absolutePath);
      findings.push({
        code: "missing_frontmatter",
        severity: "error",
        path: relativePath,
        message: error instanceof Error ? error.message : "Markdown note has invalid frontmatter.",
      });
    }
  }
}

async function auditImportBatches(rootPath: string, db: AppDatabase | undefined, findings: WorkspaceAuditFinding[]): Promise<void> {
  const attachmentRoot = path.join(rootPath, defaultRoutingPolicy.importAttachmentRoot());
  const batchNames = await directoryNames(attachmentRoot);
  for (const batchName of batchNames) {
    const summaryPath = defaultRoutingPolicy.importSummaryNotePath(batchName);
    if (!await exists(path.join(rootPath, summaryPath))) {
      findings.push({
        code: "attachment_without_summary",
        severity: "warning",
        path: defaultRoutingPolicy.importAttachmentDir(batchName),
        message: `Import batch has attachments but no summary note at ${summaryPath}.`,
      });
    }
  }

  if (!db) {
    return;
  }

  const summaryRoot = path.join(rootPath, defaultRoutingPolicy.importSummaryDir());
  const summaryPaths = (await collectMarkdownFiles(summaryRoot)).map((filePath) => path.relative(rootPath, filePath));
  const workspaceId = workspaceIdForRoot(rootPath);
  for (const summaryPath of summaryPaths) {
    const indexed = db.sqlite
      .prepare("SELECT 1 FROM notes WHERE workspace_id = ? AND path = ? LIMIT 1")
      .get(workspaceId, summaryPath);
    if (!indexed) {
      findings.push({
        code: "import_summary_not_indexed",
        severity: "warning",
        path: summaryPath,
        message: "Import summary note exists on disk but is not present in the SQLite index.",
      });
    }
  }
}

async function auditWorkspaceContract(rootPath: string, findings: WorkspaceAuditFinding[]): Promise<void> {
  const contractPath = path.join(rootPath, "AGENTS.md");
  const contract = await readFile(contractPath, "utf8").catch(() => "");
  const requiredRoutes = [
    `${defaultRoutingPolicy.importSummaryDir()}/<batch-name>.md`,
    `${defaultRoutingPolicy.importAttachmentRoot()}/<batch-name>/`,
  ];
  const governanceRoutes = [
    "02-Profiles/<profile-id>/Memory.md",
    ".vault/decisions/<decision-id>.md",
  ];

  for (const route of requiredRoutes) {
    if (!contract.includes(route)) {
      findings.push({
        code: "agents_drift",
        severity: "warning",
        path: "AGENTS.md",
        message: `Workspace contract is missing route ${route}.`,
      });
    }
  }

  for (const route of governanceRoutes) {
    if (!contract.includes(route)) {
      findings.push({
        code: "routing_drift",
        severity: "warning",
        path: "AGENTS.md",
        message: `Workspace contract is missing governance route ${route}.`,
      });
    }
  }
}

async function collectAuditableMarkdownFiles(rootPath: string): Promise<string[]> {
  const noteRoots = ["00-Inbox", "01-Projects", "02-Profiles", "03-Knowledge", "04-Resources", "05-Templates", "07-Private", "08-Archive"];
  const groups = await Promise.all(noteRoots.map((noteRoot) => collectMarkdownFiles(path.join(rootPath, noteRoot))));
  return groups.flat().sort();
}

async function collectMarkdownFiles(rootPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md") {
      files.push(absolutePath);
    }
  }
  return files;
}

async function directoryNames(rootPath: string): Promise<string[]> {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function auditStatus(findings: WorkspaceAuditFinding[]): WorkspaceAuditStatus {
  if (findings.some((finding) => finding.severity === "error")) {
    return "fail";
  }
  if (findings.some((finding) => finding.severity === "warning")) {
    return "warning";
  }
  return "pass";
}
