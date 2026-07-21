import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInsideWorkspace } from "./pathGuard";
import { extractDocumentText, type ExtractedDocument } from "./importExtractors";

export interface ImportBatchInput {
  workspaceRoot: string;
  batchName: string;
  files: string[];
  now?: string;
}

export interface ImportJob {
  id: string;
  batchName: string;
  state: "completed" | "failed";
  attachmentDir: string;
  summaryNotePath: string;
  sourceFiles: string[];
  failureReason?: string;
}

interface ImportedDocument extends ExtractedDocument {
  attachmentRelativePath: string;
}

export async function importDocumentBatch(input: ImportBatchInput): Promise<ImportJob> {
  const batchName = sanitizeBatchName(input.batchName);
  const created = (input.now ?? new Date().toISOString()).slice(0, 10);
  const attachmentDir = `06-Attachments/Imports/${batchName}`;
  const summaryNotePath = `04-Resources/Imports/${batchName}.md`;
  const attachmentTargetDir = assertInsideWorkspace(input.workspaceRoot, attachmentDir);
  const summaryTargetPath = assertInsideWorkspace(input.workspaceRoot, summaryNotePath);

  await mkdir(attachmentTargetDir, { recursive: true });
  await mkdir(path.dirname(summaryTargetPath), { recursive: true });

  try {
    const documents: ImportedDocument[] = [];
    for (const file of input.files) {
      const extracted = await extractDocumentText(file);
      const targetFileName = sanitizeFileName(extracted.fileName);
      const attachmentRelativePath = `${attachmentDir}/${targetFileName}`;
      await copyFile(file, assertInsideWorkspace(input.workspaceRoot, attachmentRelativePath));
      documents.push({ ...extracted, attachmentRelativePath });
    }

    await writeFile(summaryTargetPath, renderSummaryNote(batchName, documents, created), "utf8");

    return {
      id: importJobId(batchName, input.now),
      batchName,
      state: "completed",
      attachmentDir,
      summaryNotePath,
      sourceFiles: documents.map((document) => document.attachmentRelativePath),
    };
  } catch (error) {
    return {
      id: importJobId(batchName, input.now),
      batchName,
      state: "failed",
      attachmentDir,
      summaryNotePath,
      sourceFiles: [],
      failureReason: error instanceof Error ? error.message : "Unknown import failure",
    };
  }
}

function renderSummaryNote(batchName: string, documents: ImportedDocument[], created: string): string {
  const sourceLinks = documents.map((document) => sourceLinkFor(document.attachmentRelativePath));
  const summary = firstMeaningfulParagraphs(documents, 3).join(" ");
  const keyFacts = extractKeyFacts(documents);

  return `---
title: ${escapeYamlString(batchName)}
type: resource
status: imported
owner: default
scope: personal
sensitivity: normal
created: ${created}
tags: [imported]
source_type: import_batch
source_files:
${sourceLinks.map((link) => `  - ${escapeYamlString(link)}`).join("\n")}
summary: ${escapeYamlString(summary)}
---

# ${batchName}

## Summary

${summary || "Imported documents were copied into the workspace."}

## Key Facts

${keyFacts.length ? keyFacts.map((fact) => `- ${fact}`).join("\n") : "- No dates or money amounts were detected."}

## Source Files

${documents.map((document) => `- [${document.fileName}](${sourceLinkFor(document.attachmentRelativePath)})`).join("\n")}
`;
}

function firstMeaningfulParagraphs(documents: ImportedDocument[], limit: number): string[] {
  return documents
    .flatMap((document) => document.text.split(/\n\s*\n/u))
    .map((paragraph) => paragraph.replace(/^#{1,6}\s+/u, "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function extractKeyFacts(documents: ImportedDocument[]): string[] {
  const facts = new Set<string>();
  const moneyPattern = /\$\d[\d,]*(?:\.\d{2})?/gu;
  const datePattern = /\b\d{4}-\d{2}-\d{2}\b/gu;

  for (const document of documents) {
    for (const match of document.text.matchAll(moneyPattern)) {
      facts.add(`${document.fileName}: ${match[0]}`);
    }
    for (const match of document.text.matchAll(datePattern)) {
      facts.add(`${document.fileName}: ${match[0]}`);
    }
  }

  return [...facts].slice(0, 20);
}

function sourceLinkFor(attachmentRelativePath: string): string {
  return `../../${attachmentRelativePath}`;
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
