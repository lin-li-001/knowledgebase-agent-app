import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInsideWorkspace } from "./pathGuard";
import { extractDocumentText, type ExtractedDocument } from "./importExtractors";
import { defaultRoutingPolicy } from "./routingPolicy";

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
  const attachmentDir = defaultRoutingPolicy.importAttachmentDir(batchName);
  const summaryNotePath = defaultRoutingPolicy.importSummaryNotePath(batchName);
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
    for (const fact of extractEmploymentFacts(document)) {
      facts.add(fact);
    }
    for (const match of document.text.matchAll(moneyPattern)) {
      facts.add(`${document.fileName}: ${match[0]}`);
    }
    for (const match of document.text.matchAll(datePattern)) {
      facts.add(`${document.fileName}: ${match[0]}`);
    }
  }

  return [...facts].slice(0, 20);
}

function extractEmploymentFacts(document: ImportedDocument): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  const employmentPattern =
    /^(.{2,120}?)\s+\|\s+([A-Z][a-z]{2,8})\s+(\d{4})\s*[–-]\s*(Present|([A-Z][a-z]{2,8})\s+(\d{4}))$/u;

  for (const rawLine of document.text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+/gu, " ").trim();
    const match = employmentPattern.exec(line);
    if (!match) {
      continue;
    }

    const organization = match[1]?.trim();
    const startMonthName = match[2];
    const startYearText = match[3];
    const endRange = match[4];
    if (!organization || !startMonthName || !startYearText || !endRange) {
      continue;
    }

    const startMonth = monthNumber(startMonthName);
    const startYear = Number(startYearText);
    const endMonth = endRange === "Present" ? new Date().getMonth() + 1 : monthNumber(match[5]);
    const endYear = endRange === "Present" ? new Date().getFullYear() : Number(match[6]);
    if (!startMonth || !endMonth || !Number.isFinite(startYear) || !Number.isFinite(endYear)) {
      continue;
    }

    const range = `${startMonthName} ${startYear} - ${endRange === "Present" ? "Present" : `${match[5]} ${endYear}`}`;
    const coveredYears = yearsCovered(startYear, startMonth, endYear, endMonth);
    const suffix = coveredYears.length ? ` (covers ${coveredYears.join(", ")})` : "";
    const fact = `${document.fileName}: Employment: ${organization} | ${range}${suffix}`;
    if (!seen.has(fact)) {
      seen.add(fact);
      facts.push(fact);
    }
  }

  return facts;
}

function yearsCovered(startYear: number, startMonth: number, endYear: number, endMonth: number): number[] {
  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    const beginsBeforeYearEnds = startYear < year || startMonth <= 12;
    const endsAfterYearStarts = endYear > year || endMonth >= 1;
    if (beginsBeforeYearEnds && endsAfterYearStarts) {
      years.push(year);
    }
  }
  return years;
}

function monthNumber(month: string | undefined): number | undefined {
  if (!month) {
    return undefined;
  }

  return {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  }[month.toLocaleLowerCase()];
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
