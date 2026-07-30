import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractDocumentText, type ExtractedDocument } from "./importExtractors";
import {
  detectImportSignals,
  mergeImportClassification,
  type SavedImportRule,
} from "./importClassification";
import { importCandidateRoutingPolicy } from "./importCandidateRoutingPolicy";
import {
  evaluateImportSafety,
  type ClassificationSignal,
  type ClassificationDiagnostic,
  type ContentCategory,
  type ImportClassification,
  type ImportSensitivity,
  type SafetyDecision,
} from "./importSafety";
import {
  discardImportPromotionJournal,
  promoteImportArtifact,
  recoverImportPromotions,
} from "./importPromotion";
import { assertInsideWorkspace } from "./pathGuard";
import { defaultRoutingPolicy } from "./routingPolicy";
import {
  secureCopyFileIntoWorkspace,
  secureEnsureWorkspaceDirectory,
  secureReadWorkspaceArtifact,
  secureReadWorkspaceDirectory,
  secureReadWorkspaceText,
  secureRemoveWorkspaceArtifact,
  secureRewriteWorkspaceFile,
  secureUnlinkWorkspaceFile,
  secureWorkspacePathExists,
  secureWriteWorkspaceFileExclusive,
  type SecureWorkspaceArtifactIdentity,
  type SecureWorkspaceIoHooks,
} from "./secureWorkspaceIo";

export interface ImportBatchInput {
  workspaceRoot: string;
  batchName: string;
  files: string[];
  now?: string;
  fileOps?: Partial<ImportFileOps>;
  ioHooks?: SecureWorkspaceIoHooks;
}

export type ImportArtifactStatus =
  | "classifying"
  | "pending_review"
  | "auto_written"
  | "approved"
  | "blocked"
  | "rejected";

export interface ImportSourceNote {
  sourceFile: string;
  attachmentPath: string;
  notePath: string;
  status: ImportArtifactStatus;
  destination?: string;
  classification: ImportClassification;
  safetyDecision: SafetyDecision;
}

export interface ImportFileOps {
  copyFile(sourcePath: string, targetPath: string): Promise<void>;
  mkdir(directoryPath: string): Promise<void>;
  pathExists(targetPath: string): Promise<boolean>;
  readFile(targetPath: string): Promise<Buffer>;
  readdir(directoryPath: string): Promise<string[]>;
  unlink(targetPath: string): Promise<void>;
  writeFile(targetPath: string, contents: string | Buffer, exclusive: boolean): Promise<void>;
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
  attachmentArtifact: SecureWorkspaceArtifactIdentity;
  attachmentRelativePath: string;
  sourceStem: string;
}

interface WorkspaceRoutingPolicyFile {
  rules?: unknown[];
}

interface RoutedDocument {
  classification: ImportClassification;
  destination: string;
}

interface RenderSourceNoteInput {
  attachmentPath: string;
  classification: ImportClassification;
  created: string;
  destination: string;
  document: ImportedDocument;
  notePath: string;
  safetyDecision: SafetyDecision;
  status: ImportArtifactStatus;
  summary: string;
  title: string;
}

export async function importDocumentBatch(input: ImportBatchInput): Promise<ImportJob> {
  const batchName = sanitizeBatchName(input.batchName);
  const id = importJobId(batchName, input.now);
  const created = (input.now ?? new Date().toISOString()).slice(0, 10);
  const attachmentDir = defaultRoutingPolicy.importAttachmentDir(batchName);
  const attachmentTargetDir = assertInsideWorkspace(input.workspaceRoot, attachmentDir);
  const fileOps: ImportFileOps = { ...defaultImportFileOps, ...input.fileOps };
  const createdDerivedArtifacts = new Map<string, SecureWorkspaceArtifactIdentity>();
  const copiedSourceFiles: string[] = [];

  try {
    await recoverImportPromotions(
      input.workspaceRoot,
      secureIoHookOptions(input.ioHooks),
    );
    assertImportAttachmentPath(input.workspaceRoot, attachmentDir);
    await secureEnsureWorkspaceDirectory(input.workspaceRoot, attachmentTargetDir);
    const documents: ImportedDocument[] = [];
    const [attachmentNames, sourceStems] = await Promise.all([
      existingNames(
        input.workspaceRoot,
        attachmentTargetDir,
        "attachment_list",
        input.ioHooks,
      ),
      existingSourceStems(input.workspaceRoot, id, input.ioHooks),
    ]);
    for (const file of input.files) {
      const targetFileName = uniqueFileName(
        sanitizeFileName(path.basename(file)),
        attachmentNames,
      );
      const attachmentRelativePath = `${attachmentDir}/${targetFileName}`;
      const attachmentTargetPath = assertImportAttachmentPath(
        input.workspaceRoot,
        attachmentRelativePath,
      );
      const copied = await secureCopyFileIntoWorkspace(
        input.workspaceRoot,
        file,
        attachmentTargetPath,
        secureIoOptions("attachment_create", input.ioHooks),
      );
      copiedSourceFiles.push(attachmentRelativePath);
      const extracted = await extractDocumentText(
        attachmentTargetPath,
        copied.contents,
      );
      const sourceStem = uniqueSourceStem(sourceTitle(extracted.fileName), sourceStems);
      documents.push({
        ...extracted,
        attachmentArtifact: copied.artifact,
        attachmentRelativePath,
        sourceStem,
      });
    }

    const policy = await readWorkspaceRoutingPolicy(
      input.workspaceRoot,
      input.ioHooks,
    );
    const notes: ImportSourceNote[] = [];
    for (const document of documents) {
      notes.push(await persistSourceNote(
        input.workspaceRoot,
        id,
        batchName,
        created,
        document,
        policy,
        fileOps,
        createdDerivedArtifacts,
        input.ioHooks,
      ));
    }

    return {
      id,
      batchName,
      state: "completed",
      attachmentDir,
      sourceFiles: copiedSourceFiles,
      notes,
    };
  } catch (error) {
    await cleanupCreatedArtifacts(
      input.workspaceRoot,
      fileOps,
      createdDerivedArtifacts,
      input.ioHooks,
    );
    return {
      id,
      batchName,
      state: "failed",
      attachmentDir,
      sourceFiles: copiedSourceFiles,
      notes: [],
      failureReason: error instanceof Error ? error.message : "Unknown import failure",
    };
  }
}

async function persistSourceNote(
  workspaceRoot: string,
  importId: string,
  batchName: string,
  created: string,
  document: ImportedDocument,
  policy: WorkspaceRoutingPolicyFile,
  fileOps: ImportFileOps,
  createdArtifacts: Map<string, SecureWorkspaceArtifactIdentity>,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<ImportSourceNote> {
  const title = document.sourceStem;
  const routed = routeDocument(batchName, title, document, policy);
  const stagingPath = defaultRoutingPolicy.importStagingNotePath(importId, title);
  const stagingTargetPath = assertInsideWorkspace(workspaceRoot, stagingPath);
  const destinationTargetPath = safeWorkspacePath(workspaceRoot, routed.destination);
  const safetyDecision = evaluateImportSafety({
    workspaceRoot,
    operation: "create",
    destination: routed.destination,
    destinationExists: destinationTargetPath === undefined
      ? false
      : await secureWorkspacePathExists(workspaceRoot, destinationTargetPath),
    autoWriteThreshold: 0.95,
    classification: routed.classification,
  });
  const status = artifactStatusFor(safetyDecision);
  const notePath = status === "auto_written" ? routed.destination : stagingPath;
  const rendered = renderImportedSourceNote({
    attachmentPath: document.attachmentRelativePath,
    classification: routed.classification,
    created,
    destination: routed.destination,
    document,
    notePath,
    safetyDecision,
    status,
    summary: summaryFor(document),
    title,
  });

  assertImportStagingPath(workspaceRoot, stagingPath);
  const stagingArtifact = await secureWriteWorkspaceFileExclusive(
    workspaceRoot,
    stagingTargetPath,
    rendered,
    secureIoOptions("staging_create", ioHooks),
  );
  createdArtifacts.set(stagingTargetPath, stagingArtifact);

  if (safetyDecision.decision === "auto_write") {
    const finalTargetPath = assertInsideWorkspace(workspaceRoot, routed.destination);
    try {
      const promoted = await promoteImportArtifact({
        workspaceRoot,
        sourcePath: document.attachmentRelativePath,
        stagingPath,
        finalPath: routed.destination,
        ...(ioHooks === undefined ? {} : { ioHooks }),
        unlinkFile: fileOps.unlink,
      });
      createdArtifacts.set(finalTargetPath, promoted.final);
      createdArtifacts.delete(stagingTargetPath);
    } catch (error) {
      try {
        await recoverImportPromotions(
          workspaceRoot,
          secureIoHookOptions(ioHooks),
        );
        if (
          await secureWorkspacePathExists(workspaceRoot, finalTargetPath)
          && !await secureWorkspacePathExists(workspaceRoot, stagingTargetPath)
        ) {
          const recovered = await secureReadWorkspaceArtifact(
            workspaceRoot,
            finalTargetPath,
            secureIoOptions("final_recovered_track", ioHooks),
          );
          createdArtifacts.set(finalTargetPath, recovered.artifact);
          createdArtifacts.delete(stagingTargetPath);
          return sourceNoteResult(
            document,
            routed,
            routed.destination,
            "auto_written",
            safetyDecision,
          );
        }
      } catch (recoveryError) {
        if (!isFileAlreadyExists(error)) {
          createdArtifacts.delete(stagingTargetPath);
          throw recoveryError;
        }
      }

      if (!isFileAlreadyExists(error)) {
        createdArtifacts.delete(stagingTargetPath);
        throw error;
      }
      await discardImportPromotionJournal(
        workspaceRoot,
        document.attachmentRelativePath,
        stagingPath,
        routed.destination,
        ioHooks,
      );
      const blockedSafetyDecision = blockedPromotionSafetyDecision(error);
      const blockedNotePath = stagingPath;
      const blockedStaging = await secureRewriteWorkspaceFile(
        workspaceRoot,
        stagingTargetPath,
        renderImportedSourceNote({
          attachmentPath: document.attachmentRelativePath,
          classification: routed.classification,
          created,
          destination: routed.destination,
          document,
          notePath: blockedNotePath,
          safetyDecision: blockedSafetyDecision,
          status: "blocked",
          summary: summaryFor(document),
          title,
        }),
        secureIoOptions("staging_blocked_rewrite", ioHooks),
      );
      createdArtifacts.set(stagingTargetPath, blockedStaging);

      return sourceNoteResult(
        document,
        routed,
        blockedNotePath,
        "blocked",
        blockedSafetyDecision,
      );
    }
  }

  return sourceNoteResult(document, routed, notePath, status, safetyDecision);
}

function sourceNoteResult(
  document: ImportedDocument,
  routed: RoutedDocument,
  notePath: string,
  status: ImportArtifactStatus,
  safetyDecision: SafetyDecision,
): ImportSourceNote {
  return {
    sourceFile: document.fileName,
    attachmentPath: document.attachmentRelativePath,
    notePath,
    status,
    destination: routed.destination,
    classification: routed.classification,
    safetyDecision,
  };
}

function routeDocument(
  batchName: string,
  title: string,
  document: ImportedDocument,
  policy: WorkspaceRoutingPolicyFile,
): RoutedDocument {
  const detectorSignals = detectImportSignals({
    batchName,
    fileName: document.fileName,
    text: document.text,
  });
  const year = firstYear(document.text) ?? firstYear(batchName);
  const isFinance = detectorSignals.some((signal) => signal.category === "finance.utility");
  const hasPersonalFacts = detectorSignals.some((signal) => signal.category === "profile.career");
  const fallbackDestination = isFinance
    ? importCandidateRoutingPolicy.financeUtilitiesDestination(
      year === undefined ? { batchName: title } : { batchName: title, year },
    )
    : hasPersonalFacts
      ? importCandidateRoutingPolicy.profileMemoryDestination("default")
      : importCandidateRoutingPolicy.inboxFallbackDestination({ batchName });
  const savedRuleSignals = savedRoutingRuleSignals(policy, `${title}\n${document.fileName}\n${document.text}`);
  const classification = mergeImportClassification({
    signals: [...detectorSignals, ...savedRuleSignals],
    fallbackDestination,
  });
  const destination = classification.suggestedDestination ?? fallbackDestination;

  return {
    classification,
    destination,
  };
}

function renderImportedSourceNote(input: RenderSourceNoteInput): string {
  const sourceLink = sourceLinkFor(input.notePath, input.attachmentPath);
  const documentBody = input.document.markdownBody || ocrMessage(input.document);
  const tags = `[imported, ${input.status.replace(/_/gu, "-")}]`;

  return `---
title: ${escapeYamlString(input.title)}
type: resource
status: ${input.status}
owner: default
scope: personal
sensitivity: ${input.classification.sensitivity}
created: ${input.created}
tags: ${tags}
source_type: import
source_file: ${escapeYamlString(sourceLink)}
summary: ${escapeYamlString(input.summary)}
content_category: ${input.classification.primaryCategory}
classification_confidence: ${input.classification.confidence}
classification_evidence: ${JSON.stringify(input.classification.evidence)}
review_decision: ${input.safetyDecision.decision}
safety_reason_codes: ${JSON.stringify(input.safetyDecision.reasonCodes)}
route_status: ${input.status}
route_destination: ${escapeYamlString(input.destination)}
${input.document.pageCount ? `page_count: ${input.document.pageCount}\n` : ""}${input.document.requiresOcr ? "requires_ocr: true\n" : ""}---

# ${input.title}

## Document

${documentBody}

## Source

- [Original file](${sourceLink})

## Routing

- Status: ${input.status}
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

function savedRoutingRuleSignals(policy: WorkspaceRoutingPolicyFile, haystack: string): ClassificationSignal[] {
  const normalizedHaystack = haystack.toLocaleLowerCase();
  // The merger keeps the first same-priority signal, making policy order the durable tie-breaker.
  return policy.rules
    ?.map(parseSavedImportRule)
    .filter((candidate): candidate is SavedImportRule => candidate !== undefined)
    .filter((rule) => normalizedHaystack.includes(rule.pattern.toLocaleLowerCase()))
    .map((rule) => ({
      source: "saved_user_policy",
      ...(rule.category === undefined ? {} : { category: rule.category }),
      ...(rule.sensitivity === undefined ? {} : { sensitivity: rule.sensitivity }),
      destination: rule.destination,
      ...(rule.id === undefined ? {} : { ruleId: rule.id }),
      ...(rule.diagnostics === undefined ? {} : { diagnostics: rule.diagnostics }),
      evidence: [
        `Saved routing rule: ${truncate(rule.pattern, 240)}`,
        ...(rule.diagnosticEvidence ?? []),
      ],
    })) ?? [];
}

function parseSavedImportRule(value: unknown): SavedImportRule | undefined {
  if (!isRecord(value) || !nonEmptyString(value.pattern) || !nonEmptyString(value.destination)) {
    return undefined;
  }

  const diagnostics: ClassificationDiagnostic[] = [];
  const diagnosticEvidence: string[] = [];
  if (hasOwn(value, "category") && !isContentCategory(value.category)) {
    diagnostics.push("INVALID_SAVED_RULE_CATEGORY");
    diagnosticEvidence.push(
      `Saved routing rule has invalid category: ${String(value.category)}`,
    );
  }
  if (hasOwn(value, "sensitivity") && !isImportSensitivity(value.sensitivity)) {
    diagnostics.push("INVALID_SAVED_RULE_SENSITIVITY");
    diagnosticEvidence.push(
      `Saved routing rule has invalid sensitivity: ${String(value.sensitivity)}`,
    );
  }

  return {
    pattern: value.pattern,
    destination: value.destination,
    ...(isContentCategory(value.category) ? { category: value.category } : {}),
    ...(isImportSensitivity(value.sensitivity) ? { sensitivity: value.sensitivity } : {}),
    ...(nonEmptyString(value.id) ? { id: value.id } : {}),
    ...(diagnostics.length === 0 ? {} : { diagnostics, diagnosticEvidence }),
  };
}

const contentCategories = new Set<ContentCategory>([
  "finance.utility",
  "finance.insurance",
  "finance.tax",
  "finance.statement",
  "profile.career",
  "profile.personal_fact",
  "memory.candidate",
  "decision.record",
  "project.document",
  "resource",
  "unknown",
]);

const importSensitivities = new Set<ImportSensitivity>(["normal", "personal", "private", "restricted"]);

function isContentCategory(value: unknown): value is ContentCategory {
  return typeof value === "string" && contentCategories.has(value as ContentCategory);
}

function isImportSensitivity(value: unknown): value is ImportSensitivity {
  return typeof value === "string" && importSensitivities.has(value as ImportSensitivity);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

async function readWorkspaceRoutingPolicy(
  workspaceRoot: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<WorkspaceRoutingPolicyFile> {
  const policyPath = assertInsideWorkspace(
    workspaceRoot,
    ".vault/routing-policy.json",
  );
  if (!await secureWorkspacePathExists(workspaceRoot, policyPath)) {
    return {};
  }
  try {
    return JSON.parse(
      await secureReadWorkspaceText(
        workspaceRoot,
        policyPath,
        secureIoOptions("routing_policy_read", ioHooks),
      ),
    ) as WorkspaceRoutingPolicyFile;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return {};
  }
}

async function existingSourceStems(
  workspaceRoot: string,
  importId: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<Set<string>> {
  const directories = [path.dirname(assertInsideWorkspace(workspaceRoot, defaultRoutingPolicy.importStagingNotePath(importId, "source")))];
  const names = await Promise.all(directories.map((directoryPath) => existingNames(
    workspaceRoot,
    directoryPath,
    "staging_list",
    ioHooks,
  )));
  return new Set(
    names
      .flatMap((entries) => [...entries])
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -".md".length)),
  );
}

async function existingNames(
  workspaceRoot: string,
  directoryPath: string,
  operation: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<Set<string>> {
  try {
    return new Set(
      (
        await secureReadWorkspaceDirectory(
          workspaceRoot,
          directoryPath,
          secureIoOptions(operation, ioHooks),
        )
      ).map((name) => name.toLocaleLowerCase()),
    );
  } catch (error) {
    if (isMissingPath(error)) {
      return new Set<string>();
    }
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
  return sanitizeImportId(`${batchName}-${now ?? "now"}`);
}

function sanitizeImportId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "import";
}

function safeWorkspacePath(workspaceRoot: string, relativePath: string): string | undefined {
  try {
    return assertInsideWorkspace(workspaceRoot, relativePath);
  } catch {
    return undefined;
  }
}

function artifactStatusFor(safetyDecision: SafetyDecision): ImportArtifactStatus {
  if (safetyDecision.decision === "auto_write") {
    return "auto_written";
  }
  return safetyDecision.decision === "blocked" ? "blocked" : "pending_review";
}

const defaultImportFileOps: ImportFileOps = {
  copyFile: (sourcePath, targetPath) => copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL),
  mkdir: async (directoryPath) => { await mkdir(directoryPath, { recursive: true }); },
  pathExists: async (targetPath) => {
    try {
      await access(targetPath);
      return true;
    } catch (error) {
      if (isMissingPath(error)) {
        return false;
      }
      throw error;
    }
  },
  readFile: (targetPath) => readFile(targetPath),
  readdir: (directoryPath) => readdir(directoryPath),
  unlink: (targetPath) => unlink(targetPath),
  writeFile: (targetPath, contents, exclusive) => writeFile(targetPath, contents, exclusive ? { flag: "wx" } : undefined),
};

async function cleanupCreatedArtifacts(
  workspaceRoot: string,
  fileOps: ImportFileOps,
  createdArtifacts: Map<string, SecureWorkspaceArtifactIdentity>,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  for (const artifact of [...createdArtifacts.values()].reverse()) {
    try {
      if (!await secureWorkspacePathExists(workspaceRoot, artifact.targetPath)) {
        continue;
      }
      await secureRemoveWorkspaceArtifact(
        workspaceRoot,
        artifact,
        {
          ...secureIoOptions("failed_import_cleanup", ioHooks),
          unlinkFile: fileOps.unlink,
        },
      );
    } catch (error) {
      if (!isMissingPath(error)) {
        continue;
      }
    }
  }
}

function blockedPromotionSafetyDecision(error: unknown): SafetyDecision {
  return {
    decision: "blocked",
    reasonCodes: [isFileAlreadyExists(error) ? "DESTINATION_EXISTS" : "INTERNAL_EVALUATION_ERROR"],
  };
}

function isFileAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function assertImportAttachmentPath(
  workspaceRoot: string,
  targetPath: string,
): string {
  const normalized = assertInsideWorkspace(workspaceRoot, targetPath);
  const relative = workspaceRelativePath(workspaceRoot, normalized);
  if (!relative.startsWith(`${defaultRoutingPolicy.importAttachmentRoot()}/`)) {
    throw new Error("Import attachment path is outside the attachment root");
  }
  return normalized;
}

function assertImportStagingPath(
  workspaceRoot: string,
  targetPath: string,
): string {
  const normalized = assertInsideWorkspace(workspaceRoot, targetPath);
  const relative = workspaceRelativePath(workspaceRoot, normalized);
  if (
    !relative.startsWith(`${defaultRoutingPolicy.importStagingRoot()}/`)
    || path.posix.extname(relative) !== ".md"
  ) {
    throw new Error("Import staging path is outside the staging root");
  }
  return normalized;
}

function workspaceRelativePath(
  workspaceRoot: string,
  targetPath: string,
): string {
  return path
    .relative(path.resolve(workspaceRoot), targetPath)
    .split(path.sep)
    .join("/");
}

function secureIoOptions(
  operation: string,
  ioHooks?: SecureWorkspaceIoHooks,
): { operation: string; hooks?: SecureWorkspaceIoHooks } {
  return {
    operation,
    ...(ioHooks === undefined ? {} : { hooks: ioHooks }),
  };
}

function secureIoHookOptions(
  ioHooks?: SecureWorkspaceIoHooks,
): { ioHooks?: SecureWorkspaceIoHooks } {
  return ioHooks === undefined ? {} : { ioHooks };
}

function escapeYamlString(value: string): string {
  return JSON.stringify(value);
}
