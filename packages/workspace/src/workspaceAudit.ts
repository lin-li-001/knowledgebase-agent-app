import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AppDatabase } from "@kb-agent/storage";
import { parseMarkdownDocument, parseMarkdownNote } from "./markdown";
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
    | "attachment_without_source_note"
    | "import_source_note_not_indexed"
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
  const attachments = await collectFiles(attachmentRoot);
  const sourceNotes = await collectImportedSourceNotes(rootPath, attachmentRoot);
  const sourceAttachmentPaths = new Set(sourceNotes.map((note) => note.attachmentPath));

  for (const attachmentPath of attachments) {
    if (!sourceAttachmentPaths.has(attachmentPath)) {
      findings.push({
        code: "attachment_without_source_note",
        severity: "warning",
        path: path.relative(rootPath, attachmentPath),
        message: "Imported attachment has no authoritative source Markdown note.",
      });
    }
  }

  if (!db) {
    return;
  }

  const workspaceId = workspaceIdForRoot(rootPath);
  for (const sourceNote of sourceNotes) {
    if (sourceNote.staged) {
      continue;
    }
    const sourceNotePath = path.relative(rootPath, sourceNote.notePath);
    const indexed = db.sqlite
      .prepare("SELECT 1 FROM notes WHERE workspace_id = ? AND path = ? LIMIT 1")
      .get(workspaceId, sourceNotePath);
    if (!indexed) {
      findings.push({
        code: "import_source_note_not_indexed",
        severity: "warning",
        path: sourceNotePath,
        message: "Imported source note exists on disk but is not present in the SQLite index.",
      });
    }
  }
}

async function auditWorkspaceContract(rootPath: string, findings: WorkspaceAuditFinding[]): Promise<void> {
  const contractPath = path.join(rootPath, "AGENTS.md");
  const contract = await readFile(contractPath, "utf8").catch(() => "");
  const requiredRoutes = [
    `${defaultRoutingPolicy.importStagingRoot()}/<import-id>/<source-stem>.md`,
    `${defaultRoutingPolicy.importAttachmentRoot()}/<import-id>/`,
    `${defaultRoutingPolicy.importInboxDir()}/<import-id>.md`,
  ];
  const governanceRoutes = [
    "02-Profiles/<profile-id>/Memory.md",
    "02-Personal/<profile-id>/Finance/",
    ".vault/decisions/<decision-id>.md",
    "Import candidate routing precedence",
  ];
  const importedSourceNoteRouteStatusFields = ["route_status", "route_destination"];

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

  if (
    /Imported source Markdown notes[^\n]*04-Resources\/Imports\/[^\n]*pending Review/iu
      .test(contract)
  ) {
    findings.push({
      code: "agents_drift",
      severity: "warning",
      path: "AGENTS.md",
      message: "Workspace contract retains an obsolete 04-Resources/Imports pending-note route.",
    });
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

  for (const field of importedSourceNoteRouteStatusFields) {
    if (!contract.includes(field)) {
      findings.push({
        code: "routing_drift",
        severity: "warning",
        path: "AGENTS.md",
        message: `Workspace contract is missing imported source note route field ${field}.`,
      });
    }
  }
}

async function collectAuditableMarkdownFiles(rootPath: string): Promise<string[]> {
  const noteRoots = ["00-Inbox", "01-Projects", "02-Personal", "02-Profiles", "03-Knowledge", "04-Resources", "05-Templates", "07-Private", "08-Archive"];
  const groups = await Promise.all(noteRoots.map((noteRoot) => collectMarkdownFiles(path.join(rootPath, noteRoot))));
  return groups.flat().sort();
}

async function collectMarkdownFiles(rootPath: string): Promise<string[]> {
  return collectFiles(rootPath, (name) => name.endsWith(".md") && name !== "AGENTS.md");
}

async function collectFiles(rootPath: string, include: (name: string) => boolean = () => true): Promise<string[]> {
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
      files.push(...(await collectFiles(absolutePath, include)));
    } else if (entry.isFile() && include(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

interface ImportedSourceNote {
  notePath: string;
  attachmentPath: string;
  staged: boolean;
}

async function collectImportedSourceNotes(rootPath: string, attachmentRoot: string): Promise<ImportedSourceNote[]> {
  const [auditablePaths, stagedPaths] = await Promise.all([
    collectAuditableMarkdownFiles(rootPath),
    collectMarkdownFiles(
      path.join(rootPath, defaultRoutingPolicy.importStagingRoot()),
    ),
  ]);
  const markdownPaths = [
    ...auditablePaths.map((notePath) => ({ notePath, staged: false })),
    ...stagedPaths.map((notePath) => ({ notePath, staged: true })),
  ];
  const notes = await Promise.all(markdownPaths.map(async ({ notePath, staged }) => {
    const raw = await readFile(notePath, "utf8");
    if (!/^source_type:\s*import\s*$/mu.test(raw)) {
      return undefined;
    }
    let document;
    try {
      document = parseMarkdownDocument(raw);
    } catch {
      return undefined;
    }
    if (document.frontmatter.source_type !== "import") {
      return undefined;
    }
    const sourceFile = document.frontmatter.source_file;
    if (typeof sourceFile !== "string" || sourceFile.trim() === "") {
      return undefined;
    }
    const attachmentPath = path.resolve(
      path.dirname(notePath),
      unescapeMarkdownPath(sourceFile),
    );
    const relativeAttachment = path.relative(attachmentRoot, attachmentPath);
    if (relativeAttachment.startsWith("..") || path.isAbsolute(relativeAttachment)) {
      return undefined;
    }
    return { notePath, attachmentPath, staged };
  }));
  return notes.filter((note): note is ImportedSourceNote => Boolean(note));
}

function unescapeMarkdownPath(value: string): string {
  return value.replace(/\\([\\()])/gu, "$1");
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
