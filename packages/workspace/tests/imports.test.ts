import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractDocumentText } from "../src/importExtractors";
import { importDocumentBatch, parseMarkdownNote } from "../src/index";

describe("importDocumentBatch", () => {
  it("copies original files into a batch attachment folder and writes a summary note", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const files = await writeUtilityBills(sourceDir);

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "2026 Utility Bills",
      files,
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.state).toBe("completed");
    expect(job.attachmentDir).toBe("06-Attachments/Imports/2026 Utility Bills");
    expect(job.summaryNotePath).toBe("04-Resources/Imports/2026 Utility Bills.md");

    await expect(readFile(path.join(root, "06-Attachments/Imports/2026 Utility Bills/2026-01 Electric.txt"), "utf8")).resolves.toContain(
      "Electric bill January 2026",
    );
    await expect(readFile(path.join(root, "06-Attachments/Imports/2026 Utility Bills/2026-02 Water.md"), "utf8")).resolves.toContain(
      "Water bill February 2026",
    );
  });

  it("generates a searchable imported summary note with key facts and source links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const files = await writeUtilityBills(sourceDir);

    await importDocumentBatch({
      workspaceRoot: root,
      batchName: "2026 Utility Bills",
      files,
      now: "2026-07-21T00:00:00.000Z",
    });

    const summaryPath = path.join(root, "04-Resources/Imports/2026 Utility Bills.md");
    const content = await readFile(summaryPath, "utf8");

    expect(content).toContain("source_files:");
    expect(content).toContain("## Summary");
    expect(content).toContain("Electric bill January 2026");
    expect(content).toContain("## Key Facts");
    expect(content).toContain("$123.45");
    expect(content).toContain("2026-02-14");
    expect(content).toContain("## Source Files");
    expect(content).toContain("[2026-01 Electric.txt](../../06-Attachments/Imports/2026 Utility Bills/2026-01 Electric.txt)");

    await expect(parseMarkdownNote(summaryPath)).resolves.toEqual(
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          title: "2026 Utility Bills",
          type: "resource",
          status: "imported",
          source_files: expect.arrayContaining([
            "../../06-Attachments/Imports/2026 Utility Bills/2026-01 Electric.txt",
          ]),
        }),
      }),
    );
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
    await expect(readFile(path.join(root, "04-Resources/Imports/resume.md"), "utf8")).resolves.toContain(
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

  it("extracts employment timeline facts from imported resumes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const resume = path.join(sourceDir, "Resume.txt");
    await writeFile(
      resume,
      [
        "EXPERIENCE",
        "Uber Technologies, San Francisco, CA | Mar 2019 - Feb 2021",
        "Built predictive models.",
        "LQ Digital, San Francisco, CA | Jun 2017 - Mar 2019",
        "Implemented experimentation framework.",
      ].join("\n"),
      "utf8",
    );

    await importDocumentBatch({
      workspaceRoot: root,
      batchName: "resume",
      files: [resume],
      now: "2026-07-21T00:00:00.000Z",
    });

    const content = await readFile(path.join(root, "04-Resources/Imports/resume.md"), "utf8");

    expect(content).toContain("Employment: Uber Technologies, San Francisco, CA | Mar 2019 - Feb 2021");
    expect(content).toContain("Employment: LQ Digital, San Francisco, CA | Jun 2017 - Mar 2019");
    expect(content).toContain("(covers 2017, 2018, 2019)");
  });

  it("creates an import digest with routed high-risk finance candidates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const files = await writeUtilityBills(sourceDir);

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "2026 Utility Bills",
      files,
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.digest.candidates).toContainEqual(
      expect.objectContaining({
        kind: "finance",
        risk: "high",
        proposalType: "propose_create_note",
        suggestedDestination: "02-Personal/default/Finance/Utilities/2026/2026 Utility Bills.md",
      }),
    );

    const content = await readFile(path.join(root, "04-Resources/Imports/2026 Utility Bills.md"), "utf8");
    expect(content).toContain("## Route Candidates");
    expect(content).toContain("02-Personal/default/Finance/Utilities/2026/2026 Utility Bills.md");
  });

  it("uses saved workspace routing rules when suggesting candidate destinations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const files = await writeUtilityBills(sourceDir);
    await mkdir(path.join(root, ".vault"), { recursive: true });
    await writeFile(
      path.join(root, ".vault/routing-policy.json"),
      JSON.stringify({
        version: 1,
        rules: [{ pattern: "utility bills", destination: "02-Personal/default/Finance/Utilities/2026 Bills.md" }],
      }),
      "utf8",
    );

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "2026 Utility Bills",
      files,
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.digest.candidates[0]?.suggestedDestination).toBe("02-Personal/default/Finance/Utilities/2026 Bills.md");
  });

  it("uses the inbox fallback when imported content cannot be classified", async () => {
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

    expect(job.digest.candidates).toContainEqual(
      expect.objectContaining({
        kind: "resource",
        risk: "low",
        suggestedDestination: "00-Inbox/Imports/Loose Notes.md",
      }),
    );
    await expect(readFile(path.join(root, "04-Resources/Imports/Loose Notes.md"), "utf8")).resolves.toContain(
      "00-Inbox/Imports/Loose Notes.md",
    );
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
