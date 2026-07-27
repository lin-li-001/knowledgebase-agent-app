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
