import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractDocumentText, type ExtractedDocument } from "./importExtractors";
import { importCandidateRoutingPolicy } from "./importCandidateRoutingPolicy";
import { assertInsideWorkspace } from "./pathGuard";
import { defaultRoutingPolicy } from "./routingPolicy";

export interface ImportBatchInput {
  workspaceRoot: string;
  batchName: string;
  files: string[];
  now?: string;
}

export interface ImportSourceNote {
  sourceFile: string;
  attachmentPath: string;
  notePath: string;
  routeStatus: "inbox" | "pending_review";
  destination: string;
  risk: "low" | "high";
}

export interface ImportJob {
  id: string;
  batchName: string;
  state: "completed" | "failed";
  attachmentDir: string;
  sourceFiles: string[];
  notes: ImportSourceNote[];
  failureReason?: string;
}

interface ImportedDocument extends ExtractedDocument {
  attachmentRelativePath: string;
  sourceStem: string;
}

interface WorkspaceRoutingPolicyFile {
  rules?: Array<{
    pattern?: string;
    destination?: string;
  }>;
}

interface RoutedDocument {
  destination: string;
  risk: ImportSourceNote["risk"];
  routeStatus: ImportSourceNote["routeStatus"];
}

interface RenderSourceNoteInput {
  attachmentPath: string;
  created: string;
  destination: string;
  document: ImportedDocument;
  notePath: string;
  routeStatus: ImportSourceNote["routeStatus"];
  summary: string;
  title: string;
}

export async function importDocumentBatch(input: ImportBatchInput): Promise<ImportJob> {
  const batchName = sanitizeBatchName(input.batchName);
  const created = (input.now ?? new Date().toISOString()).slice(0, 10);
  const attachmentDir = defaultRoutingPolicy.importAttachmentDir(batchName);
  const attachmentTargetDir = assertInsideWorkspace(input.workspaceRoot, attachmentDir);

  await mkdir(attachmentTargetDir, { recursive: true });

  try {
    const documents: ImportedDocument[] = [];
    const attachmentNames = new Set<string>();
    const sourceStems = new Set<string>();
    for (const file of input.files) {
      const extracted = await extractDocumentText(file);
      const targetFileName = uniqueFileName(sanitizeFileName(extracted.fileName), attachmentNames);
      const sourceStem = uniqueSourceStem(sourceTitle(extracted.fileName), sourceStems);
      const attachmentRelativePath = `${attachmentDir}/${targetFileName}`;
      await copyFile(file, assertInsideWorkspace(input.workspaceRoot, attachmentRelativePath));
      documents.push({ ...extracted, attachmentRelativePath, sourceStem });
    }

    const policy = await readWorkspaceRoutingPolicy(input.workspaceRoot);
    const notes = await Promise.all(
      documents.map((document) => persistSourceNote(input.workspaceRoot, batchName, created, document, policy, documents.length)),
    );

    return {
      id: importJobId(batchName, input.now),
      batchName,
      state: "completed",
      attachmentDir,
      sourceFiles: documents.map((document) => document.attachmentRelativePath),
      notes,
    };
  } catch (error) {
    return {
      id: importJobId(batchName, input.now),
      batchName,
      state: "failed",
      attachmentDir,
      sourceFiles: [],
      notes: [],
      failureReason: error instanceof Error ? error.message : "Unknown import failure",
    };
  }
}

async function persistSourceNote(
  workspaceRoot: string,
  batchName: string,
  created: string,
  document: ImportedDocument,
  policy: WorkspaceRoutingPolicyFile,
  sourceCount: number,
): Promise<ImportSourceNote> {
  const title = document.sourceStem;
  const routed = routeDocument(batchName, title, document, policy);
  const notePath = routed.routeStatus === "inbox"
    ? sourceCount === 1
      ? defaultRoutingPolicy.importInboxNotePath(batchName)
      : defaultRoutingPolicy.importInboxSourceNotePath(batchName, title)
    : defaultRoutingPolicy.importSourceNotePath(batchName, title);
  const targetPath = assertInsideWorkspace(workspaceRoot, notePath);

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    renderImportedSourceNote({
      attachmentPath: document.attachmentRelativePath,
      created,
      destination: routed.destination,
      document,
      notePath,
      routeStatus: routed.routeStatus,
      summary: summaryFor(document),
      title,
    }),
    "utf8",
  );

  return {
    sourceFile: document.fileName,
    attachmentPath: document.attachmentRelativePath,
    notePath,
    routeStatus: routed.routeStatus,
    destination: routed.destination,
    risk: routed.risk,
  };
}

function routeDocument(
  batchName: string,
  title: string,
  document: ImportedDocument,
  policy: WorkspaceRoutingPolicyFile,
): RoutedDocument {
  const isFinance = /\b(bill|utility|utilities|electric|water|gas|amount|due)\b/iu.test(`${batchName}\n${document.text}`)
    && /\$\d|\bamount\b|\bdue\b/iu.test(document.text);
  const hasPersonalFacts = extractEmploymentFacts(document).length > 0;
  const year = firstYear(document.text) ?? firstYear(batchName);
  const defaultDestination = isFinance
    ? importCandidateRoutingPolicy.financeUtilitiesDestination(
      year === undefined ? { batchName: title } : { batchName: title, year },
    )
    : hasPersonalFacts
      ? importCandidateRoutingPolicy.profileMemoryDestination("default")
      : importCandidateRoutingPolicy.inboxFallbackDestination({ batchName });
  const destination = routingRuleDestination(policy, `${title}\n${document.fileName}\n${document.text}`) ?? defaultDestination;
  const risk: ImportSourceNote["risk"] = isFinance || hasPersonalFacts ? "high" : "low";

  return {
    destination,
    risk,
    routeStatus: risk === "high" ? "pending_review" : "inbox",
  };
}

function renderImportedSourceNote(input: RenderSourceNoteInput): string {
  const sourceLink = sourceLinkFor(input.notePath, input.attachmentPath);
  const documentBody = input.document.markdownBody || ocrMessage(input.document);
  const tags = input.routeStatus === "inbox" ? "[imported, inbox]" : "[imported, pending-review]";

  return `---
title: ${escapeYamlString(input.title)}
type: resource
status: ${input.routeStatus}
owner: default
scope: personal
sensitivity: normal
created: ${input.created}
tags: ${tags}
source_type: import
source_file: ${escapeYamlString(sourceLink)}
summary: ${escapeYamlString(input.summary)}
route_status: ${input.routeStatus}
route_destination: ${escapeYamlString(input.destination)}
${input.document.pageCount ? `page_count: ${input.document.pageCount}\n` : ""}${input.document.requiresOcr ? "requires_ocr: true\n" : ""}---

# ${input.title}

## Summary

${input.summary}

## Document

${documentBody}

## Source

- [Original file](${sourceLink})

## Routing

- Status: ${input.routeStatus}
- Destination: ${input.destination}
`;
}

function summaryFor(document: ImportedDocument): string {
  if (document.requiresOcr) {
    return "No text was extracted from this PDF. OCR is required before its contents can be summarized.";
  }

  const blocks = documentBlocks(document.markdownBody);
  if (blocks.length === 0) {
    return "Imported source document with no extractable content.";
  }

  const metadata = `${sourceTitle(document.fileName)} contains ${blocks.length} document block${blocks.length === 1 ? "" : "s"} and ${blocks.join(" ").length} extracted characters${document.pageCount ? ` across ${document.pageCount} page${document.pageCount === 1 ? "" : "s"}` : ""}.`;
  const representativeContent = blocks.slice(1).find(Boolean);
  return representativeContent
    ? `${metadata} Representative later content: ${truncate(representativeContent, 240)}`
    : metadata;
}

function ocrMessage(document: ImportedDocument): string {
  return document.requiresOcr
    ? "This PDF has no extractable text and requires OCR."
    : "No extractable document content was found.";
}

function routingRuleDestination(policy: WorkspaceRoutingPolicyFile, haystack: string): string | undefined {
  const normalizedHaystack = haystack.toLocaleLowerCase();
  return policy.rules?.find((rule) => rule.pattern && rule.destination && normalizedHaystack.includes(rule.pattern.toLocaleLowerCase()))?.destination;
}

async function readWorkspaceRoutingPolicy(workspaceRoot: string): Promise<WorkspaceRoutingPolicyFile> {
  try {
    return JSON.parse(await readFile(assertInsideWorkspace(workspaceRoot, ".vault/routing-policy.json"), "utf8")) as WorkspaceRoutingPolicyFile;
  } catch {
    return {};
  }
}

function extractEmploymentFacts(document: ImportedDocument): string[] {
  const employmentPattern = /^.{2,120}?\s+\|\s+[A-Z][a-z]{2,8}\s+\d{4}\s*[–-]\s*(Present|[A-Z][a-z]{2,8}\s+\d{4})$/u;
  return document.text.split(/\r?\n/u).filter((line) => employmentPattern.test(line.replace(/\s+/gu, " ").trim()));
}

function documentBlocks(markdownBody: string): string[] {
  return markdownBody
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/^#{1,6}\s+/u, "").trim())
    .filter((paragraph) => Boolean(paragraph) && !/^<!-- Page \d+ -->$/u.test(paragraph));
}

function firstYear(value: string): number | undefined {
  const match = /\b(20\d{2}|19\d{2})\b/u.exec(value);
  return match ? Number(match[1]) : undefined;
}

function sourceLinkFor(notePath: string, attachmentPath: string): string {
  return path.posix.relative(path.posix.dirname(notePath), attachmentPath);
}

function sourceTitle(fileName: string): string {
  return sanitizeFileName(path.basename(fileName, path.extname(fileName)));
}

function uniqueFileName(fileName: string, usedNames: Set<string>): string {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  return uniqueName(stem, extension, usedNames);
}

function uniqueSourceStem(sourceStem: string, usedStems: Set<string>): string {
  return uniqueName(sourceStem, "", usedStems);
}

function uniqueName(stem: string, extension: string, usedNames: Set<string>): string {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? `${stem}${extension}` : `${stem}-${suffix}${extension}`;
    const normalizedCandidate = candidate.toLocaleLowerCase();
    if (!usedNames.has(normalizedCandidate)) {
      usedNames.add(normalizedCandidate);
      return candidate;
    }
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function sanitizeBatchName(batchName: string): string {
  const sanitized = batchName.trim().replace(/[/:\\]+/gu, " ").replace(/\s+/gu, " ");
  if (!sanitized) {
    throw new Error("Import batch name is required");
  }

  return sanitized;
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[/:\\]+/gu, " ").trim() || "Imported File";
}

function importJobId(batchName: string, now: string | undefined): string {
  return `${batchName}:${now ?? "now"}`;
}

function escapeYamlString(value: string): string {
  return JSON.stringify(value);
}
