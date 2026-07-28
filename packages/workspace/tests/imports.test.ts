import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractDocumentText } from "../src/importExtractors";
import { importDocumentBatch } from "../src/index";

describe("importDocumentBatch", () => {
  it("creates one Markdown note with derived summary, body, source, and route metadata for one PDF", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const pdfPath = path.join(sourceDir, "Handbook.pdf");
    await writeFile(pdfPath, minimalPdf("Handbook import test\nProduct usage policy"), "binary");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Handbook",
      files: [pdfPath],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.state).toBe("completed");
    expect(job.notes).toHaveLength(1);
    await expect(readFile(path.join(root, job.notes[0]!.attachmentPath), "utf8")).resolves.toContain("Handbook import test");
    const note = await readFile(path.join(root, job.notes[0]!.notePath), "utf8");
    expect(note).toContain("summary:");
    expect(note).toContain("<!-- Page 1 -->");
    expect(note).toContain("## Source");
    expect(note).toContain("## Routing");
    expect(note).not.toContain("## Route Candidates");
  });

  it("extracts text from imported PDF files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const resume = path.join(sourceDir, "Resume-Lin Li-2026.pdf");
    await writeFile(resume, minimalPdf("Resume Lin Li PDF Import Test\nOpenAI deployment experience"), "binary");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "resume",
      files: [resume],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.state).toBe("completed");
    await expect(readFile(path.join(root, job.notes[0]!.notePath), "utf8")).resolves.toContain(
      "Resume Lin Li PDF Import Test",
    );
  });

  it("converts each extracted PDF page into one Markdown body with page boundaries", async () => {
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const pdfPath = path.join(sourceDir, "resume.pdf");
    await writeFile(pdfPath, minimalPdf("Resume Lin Li PDF Import Test\nOpenAI deployment experience"), "binary");

    const document = await extractDocumentText(pdfPath);

    expect(document.markdownBody).toContain("<!-- Page 1 -->");
    expect(document.markdownBody).toContain("Resume Lin Li PDF Import Test");
    expect(document.pageCount).toBe(1);
  });

  it("preserves page boundaries when a PDF contains a blank middle page", async () => {
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const pdfPath = path.join(sourceDir, "three-pages.pdf");
    await writeFile(pdfPath, multiPagePdf(), "binary");

    const document = await extractDocumentText(pdfPath);

    expect(document.pageCount).toBe(3);
    expect(document.markdownBody).toContain("<!-- Page 1 -->");
    expect(document.markdownBody).toContain("<!-- Page 2 -->");
    expect(document.markdownBody).toContain("<!-- Page 3 -->");
    expect(document.markdownBody.indexOf("<!-- Page 1 -->")).toBeLessThan(
      document.markdownBody.indexOf("<!-- Page 2 -->"),
    );
    expect(document.markdownBody.indexOf("<!-- Page 2 -->")).toBeLessThan(
      document.markdownBody.indexOf("<!-- Page 3 -->"),
    );
    expect(document.markdownBody).toContain("<!-- Page 2 -->\n\n\n\n<!-- Page 3 -->");
  });

  it("marks image-only PDFs as requiring OCR", async () => {
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const imageOnlyPdfPath = path.join(sourceDir, "scan.pdf");
    await writeFile(imageOnlyPdfPath, imageOnlyPdf(), "binary");

    const document = await extractDocumentText(imageOnlyPdfPath);

    expect(document.requiresOcr).toBe(true);
  });

  it("moves an unclassified import note to Inbox immediately", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    await mkdir(sourceDir, { recursive: true });
    const file = path.join(sourceDir, "misc.txt");
    await writeFile(file, "A few loose notes without dates, money, or stable personal facts.", "utf8");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Loose Notes",
      files: [file],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.notes[0]).toMatchObject({
      routeStatus: "inbox",
      notePath: "00-Inbox/Imports/Loose Notes.md",
    });
    await expect(readFile(path.join(root, "00-Inbox/Imports/Loose Notes.md"), "utf8")).resolves.toContain("## Routing");
  });

  it("derives the summary from whole-document metadata and later content instead of repeating the opening paragraph", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const source = path.join(sourceDir, "Handbook.txt");
    await writeFile(
      source,
      ["Opening policy paragraph that must remain only in the document body.", "Later implementation detail used for the summary."].join("\n\n"),
      "utf8",
    );

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Handbook",
      files: [source],
      now: "2026-07-21T00:00:00.000Z",
    });

    const note = await readFile(path.join(root, job.notes[0]!.notePath), "utf8");
    const summary = markdownSection(note, "Summary");
    const document = markdownSection(note, "Document");

    expect(document).toContain("Opening policy paragraph that must remain only in the document body.");
    expect(summary).not.toContain("Opening policy paragraph that must remain only in the document body.");
    expect(summary).toContain("Later implementation detail used for the summary.");
  });

  it("keeps one Inbox note per source when a batch has multiple unclassified files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const first = path.join(sourceDir, "First.txt");
    const second = path.join(sourceDir, "Second.txt");
    await writeFile(first, "First loose note.", "utf8");
    await writeFile(second, "Second loose note.", "utf8");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Loose Notes",
      files: [first, second],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.notes.map((note) => note.notePath)).toEqual([
      "00-Inbox/Imports/Loose Notes/First.md",
      "00-Inbox/Imports/Loose Notes/Second.md",
    ]);
  });

  it("adds deterministic suffixes when attachment names or source-note stems collide", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const firstDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const secondDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const thirdDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const pdf = path.join(firstDir, "report.pdf");
    const text = path.join(secondDir, "report.txt");
    const duplicateText = path.join(thirdDir, "report.txt");
    await writeFile(pdf, minimalPdf("PDF report content"), "binary");
    await writeFile(text, "Text report content", "utf8");
    await writeFile(duplicateText, "Second text report content", "utf8");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Reports",
      files: [pdf, text, duplicateText],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.notes.map((note) => note.attachmentPath)).toEqual([
      "06-Attachments/Imports/Reports/report.pdf",
      "06-Attachments/Imports/Reports/report.txt",
      "06-Attachments/Imports/Reports/report-2.txt",
    ]);
    expect(job.notes.map((note) => note.notePath)).toEqual([
      "00-Inbox/Imports/Reports/report.md",
      "00-Inbox/Imports/Reports/report-2.md",
      "00-Inbox/Imports/Reports/report-3.md",
    ]);
    await expect(readFile(path.join(root, job.notes[2]!.attachmentPath), "utf8")).resolves.toBe("Second text report content");
  });

  it("preserves attachments and source notes across separate imports into the same batch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const firstDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const secondDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const first = path.join(firstDir, "report.txt");
    const second = path.join(secondDir, "report.txt");
    await writeFile(first, "Electric bill\nDue: 2026-01-15\nAmount: $123.45", "utf8");
    await writeFile(second, "Electric bill\nDue: 2026-02-15\nAmount: $456.78", "utf8");

    const firstJob = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Reports",
      files: [first],
      now: "2026-07-21T00:00:00.000Z",
    });
    const secondJob = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Reports",
      files: [second],
      now: "2026-07-22T00:00:00.000Z",
    });

    expect(firstJob.notes[0]).toMatchObject({
      attachmentPath: "06-Attachments/Imports/Reports/report.txt",
      notePath: "04-Resources/Imports/Reports/report.md",
    });
    expect(secondJob.notes[0]).toMatchObject({
      attachmentPath: "06-Attachments/Imports/Reports/report-2.txt",
      notePath: "04-Resources/Imports/Reports/report-2.md",
    });
    await expect(readFile(path.join(root, firstJob.notes[0]!.attachmentPath), "utf8")).resolves.toContain("$123.45");
    await expect(readFile(path.join(root, secondJob.notes[0]!.attachmentPath), "utf8")).resolves.toContain("$456.78");
    await expect(readFile(path.join(root, firstJob.notes[0]!.notePath), "utf8")).resolves.toContain("$123.45");
    await expect(readFile(path.join(root, secondJob.notes[0]!.notePath), "utf8")).resolves.toContain("$456.78");
  });

  it("keeps a finance source note pending review at its staging path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const bill = path.join(sourceDir, "Electric Bill.txt");
    await writeFile(bill, "Electric bill\nDue: 2026-01-15\nAmount: $123.45", "utf8");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "2026 Utility Bills",
      files: [bill],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.notes[0]).toMatchObject({
      routeStatus: "pending_review",
      risk: "high",
      notePath: "04-Resources/Imports/2026 Utility Bills/Electric Bill.md",
      destination: "02-Personal/default/Finance/Utilities/2026/Electric Bill.md",
    });
  });
});

function markdownSection(note: string, heading: string): string {
  const match = new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, "u").exec(note);
  return match?.[1] ?? "";
}

async function writeUtilityBills(sourceDir: string): Promise<string[]> {
  await mkdir(sourceDir, { recursive: true });
  const electric = path.join(sourceDir, "2026-01 Electric.txt");
  const water = path.join(sourceDir, "2026-02 Water.md");
  const gas = path.join(sourceDir, "2026-03 Gas.txt");

  await writeFile(electric, "Electric bill January 2026\nDue: 2026-01-15\nAmount: $123.45\nUsage: 456 kWh\n", "utf8");
  await writeFile(water, "# Water bill February 2026\n\nDue: 2026-02-14\nAmount: $67.89\n", "utf8");
  await writeFile(gas, "Gas bill March 2026\nDue: 2026-03-20\nAmount: $89.10\n", "utf8");

  return [electric, water, gas];
}

function minimalPdf(text: string): Buffer {
  const escapedText = text.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)").replace(/\n/gu, " ");
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escapedText}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }

  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body);
}

function multiPagePdf(): Buffer {
  const pageOne = "BT\n/F1 18 Tf\n72 720 Td\n(Page one) Tj\nET";
  const pageTwo = "";
  const pageThree = "BT\n/F1 18 Tf\n72 720 Td\n(Page three) Tj\nET";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R >>\nendobj\n",
    "5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 9 0 R >>\nendobj\n",
    "6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `7 0 obj\n<< /Length ${Buffer.byteLength(pageOne)} >>\nstream\n${pageOne}\nendstream\nendobj\n`,
    `8 0 obj\n<< /Length ${Buffer.byteLength(pageTwo)} >>\nstream\n${pageTwo}\nendstream\nendobj\n`,
    `9 0 obj\n<< /Length ${Buffer.byteLength(pageThree)} >>\nstream\n${pageThree}\nendstream\nendobj\n`,
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }

  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body);
}

function imageOnlyPdf(): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n",
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }

  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body);
}
