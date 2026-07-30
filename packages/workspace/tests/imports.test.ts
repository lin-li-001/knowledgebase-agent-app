import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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
    expect(note).not.toContain("## Summary");
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

    const document = await extractDocumentText(pdfPath, await readFile(pdfPath));

    expect(document.markdownBody).toContain("<!-- Page 1 -->");
    expect(document.markdownBody).toContain("Resume Lin Li PDF Import Test");
    expect(document.pageCount).toBe(1);
  });

  it("preserves page boundaries when a PDF contains a blank middle page", async () => {
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const pdfPath = path.join(sourceDir, "three-pages.pdf");
    await writeFile(pdfPath, multiPagePdf(), "binary");

    const document = await extractDocumentText(pdfPath, await readFile(pdfPath));

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

    const document = await extractDocumentText(
      imageOnlyPdfPath,
      await readFile(imageOnlyPdfPath),
    );

    expect(document.requiresOcr).toBe(true);
  });

  it("keeps an unclassified import note staged pending review", async () => {
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
      status: "pending_review",
      notePath: expect.stringMatching(/^\.app\/import-staging\//),
      classification: { primaryCategory: "unknown" },
      safetyDecision: {
        decision: "review_required",
        reasonCodes: expect.arrayContaining(["CLASSIFICATION_UNKNOWN"]),
      },
    });
    await expect(readFile(path.join(root, job.notes[0]!.notePath), "utf8")).resolves.toContain("## Routing");
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
    const summary = frontmatterField(note, "summary");
    const document = markdownSection(note, "Document");

    expect(document).toContain("Opening policy paragraph that must remain only in the document body.");
    expect(summary).not.toContain("Opening policy paragraph that must remain only in the document body.");
    expect(summary).toContain("Later implementation detail used for the summary.");
  });

  it("keeps one staged note per source when a batch has multiple unclassified files", async () => {
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
      expect.stringMatching(/^\.app\/import-staging\//),
      expect.stringMatching(/^\.app\/import-staging\//),
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
      expect.stringMatching(/^\.app\/import-staging\//),
      expect.stringMatching(/^\.app\/import-staging\//),
      expect.stringMatching(/^\.app\/import-staging\//),
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
      status: "pending_review",
      notePath: expect.stringMatching(/^\.app\/import-staging\//),
    });
    expect(secondJob.notes[0]).toMatchObject({
      attachmentPath: "06-Attachments/Imports/Reports/report-2.txt",
      status: "pending_review",
      notePath: expect.stringMatching(/^\.app\/import-staging\//),
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
      status: "pending_review",
      notePath: expect.stringMatching(/^\.app\/import-staging\//),
      destination: "02-Personal/default/Finance/Utilities/2026/Electric Bill.md",
    });
  });

  it("moves a safe saved-policy import from staging to its destination without leaving a staged copy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const source = path.join(sourceDir, "Handbook.txt");
    await mkdir(path.join(root, ".vault"), { recursive: true });
    await writeFile(
      path.join(root, ".vault/routing-policy.json"),
      JSON.stringify({
        rules: [
          {
            pattern: "Handbook",
            category: "resource",
            sensitivity: "normal",
            destination: "00-Inbox/Imports/Handbook.md",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(source, "Handbook content that should remain unchanged during the move.", "utf8");

    const secureOperations: string[] = [];
    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Handbook",
      files: [source],
      now: "2026-07-21T00:00:00.000Z",
      ioHooks: {
        afterPathSnapshot: async (operation) => {
          secureOperations.push(operation);
        },
      },
    });

    expect(job.failureReason).toBeUndefined();
    expect(job).toMatchObject({ state: "completed" });
    expect(job.notes[0]).toMatchObject({
      status: "auto_written",
      notePath: "00-Inbox/Imports/Handbook.md",
      destination: "00-Inbox/Imports/Handbook.md",
      classification: { primaryCategory: "resource", sensitivity: "normal", confidence: 1 },
      safetyDecision: { decision: "auto_write", reasonCodes: [] },
    });
    await expect(readFile(path.join(root, job.notes[0]!.notePath), "utf8")).resolves.toContain(
      "Handbook content that should remain unchanged during the move.",
    );
    await expect(
      readFile(path.join(root, ".app/import-staging", job.id, "Handbook.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(secureOperations).toContain("staging_create");
    expect(secureOperations).toContain("final_create");
  });

  it("does not overwrite an existing auto-write destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const source = path.join(sourceDir, "Handbook.txt");
    const destination = path.join(root, "00-Inbox/Imports/Handbook.md");
    await mkdir(path.dirname(destination), { recursive: true });
    await mkdir(path.join(root, ".vault"), { recursive: true });
    await writeFile(destination, "Existing authoritative note.", "utf8");
    await writeFile(
      path.join(root, ".vault/routing-policy.json"),
      JSON.stringify({
        rules: [
          {
            pattern: "Handbook",
            category: "resource",
            sensitivity: "normal",
            destination: "00-Inbox/Imports/Handbook.md",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(source, "New handbook content.", "utf8");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Handbook",
      files: [source],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.notes[0]).toMatchObject({
      status: "blocked",
      notePath: expect.stringMatching(/^\.app\/import-staging\//),
      safetyDecision: {
        decision: "blocked",
        reasonCodes: expect.arrayContaining(["DESTINATION_EXISTS"]),
      },
    });
    await expect(readFile(destination, "utf8")).resolves.toBe("Existing authoritative note.");
    await expect(readFile(path.join(root, job.notes[0]!.notePath), "utf8")).resolves.toContain("New handbook content.");
  });

  it("preserves copied source attachments while cleaning derived artifacts after a later source fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const first = path.join(sourceDir, "First.txt");
    const unsupported = path.join(sourceDir, "Second.docx");
    await mkdir(path.join(root, ".vault"), { recursive: true });
    await mkdir(path.join(root, "06-Attachments/Imports/Recovery"), { recursive: true });
    await writeFile(path.join(root, "06-Attachments/Imports/Recovery/Existing.txt"), "Pre-existing attachment.", "utf8");
    await writeFile(
      path.join(root, ".vault/routing-policy.json"),
      JSON.stringify({ rules: [{ pattern: "First", category: "resource", sensitivity: "normal", destination: "00-Inbox/Imports/First.md" }] }),
      "utf8",
    );
    await writeFile(first, "First source content.", "utf8");
    await writeFile(unsupported, "Unsupported source.", "utf8");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Recovery",
      files: [first, unsupported],
      now: "2026-07-29T00:00:00.000Z",
    });

    expect(job).toMatchObject({
      state: "failed",
      sourceFiles: [
        "06-Attachments/Imports/Recovery/First.txt",
        "06-Attachments/Imports/Recovery/Second.docx",
      ],
      notes: [],
    });
    await expect(readFile(path.join(root, "06-Attachments/Imports/Recovery/First.txt"), "utf8")).resolves.toBe("First source content.");
    await expect(readFile(path.join(root, "06-Attachments/Imports/Recovery/Second.docx"), "utf8")).resolves.toBe("Unsupported source.");
    await expect(readFile(path.join(root, "00-Inbox/Imports/First.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, ".app/import-staging/Recovery-2026-07-29T00-00-00.000Z/First.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, "06-Attachments/Imports/Recovery/Existing.txt"), "utf8")).resolves.toBe("Pre-existing attachment.");
  });

  it("copies an unsupported source attachment before extraction fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const unsupported = path.join(sourceDir, "Report.docx");
    await writeFile(unsupported, "Unsupported but preserved.", "utf8");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Unsupported",
      files: [unsupported],
      now: "2026-07-29T00:00:00.000Z",
    });

    expect(job).toMatchObject({
      state: "failed",
      sourceFiles: ["06-Attachments/Imports/Unsupported/Report.docx"],
      notes: [],
    });
    await expect(
      readFile(path.join(root, "06-Attachments/Imports/Unsupported/Report.docx"), "utf8"),
    ).resolves.toBe("Unsupported but preserved.");
  });

  it("extracts from the preserved attachment snapshot when the external source changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const source = path.join(sourceDir, "Snapshot.txt");
    await writeFile(source, "Original source snapshot.", "utf8");
    let sourceChanged = false;

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Snapshot",
      files: [source],
      now: "2026-07-29T00:00:00.000Z",
      ioHooks: {
        afterPathSnapshot: async (operation) => {
          if (operation === "attachment_create" && !sourceChanged) {
            sourceChanged = true;
            await writeFile(source, "Changed external source.", "utf8");
          }
        },
      },
    });

    expect(job.state).toBe("completed");
    await expect(
      readFile(path.join(root, job.sourceFiles[0]!), "utf8"),
    ).resolves.toBe("Original source snapshot.");
    await expect(
      readFile(path.join(root, job.notes[0]!.notePath), "utf8"),
    ).resolves.toContain("Original source snapshot.");
    await expect(
      readFile(path.join(root, job.notes[0]!.notePath), "utf8"),
    ).resolves.not.toContain("Changed external source.");
  });

  it("never parses outside bytes when a copied attachment is swapped to a symlink before extraction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-import-outside-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const source = path.join(sourceDir, "Snapshot.txt");
    const outsideSource = path.join(outside, "Outside.txt");
    await writeFile(source, "Original source snapshot.", "utf8");
    await writeFile(outsideSource, "OUTSIDE BYTES MUST NOT BE PARSED", "utf8");
    let swapped = false;

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Snapshot Symlink",
      files: [source],
      now: "2026-07-29T00:00:00.000Z",
      ioHooks: {
        afterPathSnapshot: async (operation, targetPath) => {
          if (operation !== "attachment_verify" || swapped) {
            return;
          }
          swapped = true;
          await unlink(targetPath);
          await symlink(outsideSource, targetPath);
        },
      },
    });

    expect(swapped).toBe(true);
    expect(job.state).toBe("failed");
    expect(job.notes).toEqual([]);
    await expect(readFile(outsideSource, "utf8")).resolves.toBe(
      "OUTSIDE BYTES MUST NOT BE PARSED",
    );
  });

  it("preserves a replacement final when a later source fails batch rollback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const first = path.join(sourceDir, "First.txt");
    const second = path.join(sourceDir, "Second.txt");
    const finalPath = path.join(root, "00-Inbox/Imports/First.md");
    await writeFile(first, "First source content.", "utf8");
    await writeFile(second, "Second source content.", "utf8");
    await mkdir(path.join(root, ".vault"), { recursive: true });
    await writeFile(
      path.join(root, ".vault/routing-policy.json"),
      JSON.stringify({
        rules: [
          {
            pattern: "First",
            category: "resource",
            sensitivity: "normal",
            destination: "00-Inbox/Imports/First.md",
          },
        ],
      }),
      "utf8",
    );
    let injected = false;

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Cleanup Ownership",
      files: [first, second],
      now: "2026-07-29T00:00:00.000Z",
      ioHooks: {
        afterPathSnapshot: async (operation, targetPath) => {
          if (
            operation !== "staging_create"
            || path.basename(targetPath) !== "Second.md"
            || injected
          ) {
            return;
          }
          injected = true;
          await unlink(finalPath);
          await writeFile(finalPath, "replacement final authority", "utf8");
          throw new Error("second source failed after replacement");
        },
      },
    });

    expect(injected).toBe(true);
    expect(job.state).toBe("failed");
    await expect(readFile(finalPath, "utf8")).resolves.toBe(
      "replacement final authority",
    );
  });

  it("preserves a replacement staging note when a later source fails batch rollback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const first = path.join(sourceDir, "First.txt");
    const second = path.join(sourceDir, "Second.txt");
    await writeFile(first, "First source content.", "utf8");
    await writeFile(second, "Second source content.", "utf8");
    let firstStagingPath: string | undefined;
    let injected = false;

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Cleanup Staging Ownership",
      files: [first, second],
      now: "2026-07-29T00:00:00.000Z",
      ioHooks: {
        afterPathSnapshot: async (operation, targetPath) => {
          if (operation !== "staging_create") {
            return;
          }
          if (path.basename(targetPath) === "First.md") {
            firstStagingPath = targetPath;
            return;
          }
          if (
            path.basename(targetPath) === "Second.md"
            && firstStagingPath
            && !injected
          ) {
            injected = true;
            await unlink(firstStagingPath);
            await writeFile(firstStagingPath, "replacement staging authority", "utf8");
            throw new Error("second source failed after staging replacement");
          }
        },
      },
    });

    expect(injected).toBe(true);
    expect(job.state).toBe("failed");
    await expect(readFile(firstStagingPath!, "utf8")).resolves.toBe(
      "replacement staging authority",
    );
  });

  it.each([
    {
      name: "attachment",
      symlinkPath: "06-Attachments",
      batchName: "Attachment Static",
      autoWrite: false,
    },
    {
      name: "staging",
      symlinkPath: ".app",
      batchName: "Staging Static",
      autoWrite: false,
    },
    {
      name: "final destination",
      symlinkPath: "00-Inbox",
      batchName: "Handbook",
      autoWrite: true,
    },
  ])("rejects a static symlink parent at the $name boundary", async (testCase) => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-symlink-"));
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-import-outside-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const source = path.join(sourceDir, "Handbook.txt");
    await writeFile(source, "Handbook source bytes must stay in the workspace.", "utf8");
    if (testCase.autoWrite) {
      await writeAutoWritePolicy(root);
    }
    await symlink(outside, path.join(root, testCase.symlinkPath), "dir");

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: testCase.batchName,
      files: [source],
      now: "2026-07-29T01:00:00.000Z",
    });

    expect(job.state).toBe("failed");
    expect(await readdir(outside)).toEqual([]);
  });

  it.each([
    {
      name: "attachment",
      operation: "attachment_create",
      batchName: "Attachment Race",
      autoWrite: false,
    },
    {
      name: "staging",
      operation: "staging_create",
      batchName: "Staging Race",
      autoWrite: false,
    },
    {
      name: "final destination",
      operation: "final_create",
      batchName: "Handbook",
      autoWrite: true,
    },
  ])("rejects a parent swap race at the $name boundary", async (testCase) => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-race-"));
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-import-outside-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const source = path.join(sourceDir, "Handbook.txt");
    await writeFile(source, "Handbook source bytes must not escape.", "utf8");
    if (testCase.autoWrite) {
      await writeAutoWritePolicy(root);
    }
    let swapped = false;
    const input = {
      workspaceRoot: root,
      batchName: testCase.batchName,
      files: [source],
      now: "2026-07-29T02:00:00.000Z",
      ioHooks: {
        afterPathSnapshot: async (operation: string, targetPath: string) => {
          if (operation !== testCase.operation || swapped) {
            return;
          }
          swapped = true;
          const parent = path.dirname(targetPath);
          await rename(parent, `${parent}.verified`);
          await symlink(outside, parent, "dir");
        },
      },
    };

    const job = await importDocumentBatch(input);

    expect(swapped).toBe(true);
    expect(job.state).toBe("failed");
    expect(await readdir(outside)).toEqual([]);
  });

  it("keeps a truthful blocked staging artifact when promotion races an existing destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const source = path.join(sourceDir, "Handbook.txt");
    const finalPath = path.join(root, "00-Inbox/Imports/Handbook.md");
    await writeAutoWritePolicy(root);
    await writeFile(source, "Handbook source content.", "utf8");
    let destinationCreated = false;

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Handbook",
      files: [source],
      now: "2026-07-29T00:00:00.000Z",
      ioHooks: {
        afterPathSnapshot: async (operation, targetPath) => {
          if (
            operation === "final_create"
            && targetPath === finalPath
            && !destinationCreated
          ) {
            destinationCreated = true;
            await writeFile(finalPath, "Concurrent authoritative note.", "utf8");
          }
        },
      },
    });

    expect(job.notes[0]).toMatchObject({
      status: "blocked",
      notePath: expect.stringMatching(/^\.app\/import-staging\//),
      safetyDecision: { decision: "blocked", reasonCodes: ["DESTINATION_EXISTS"] },
    });
    await expect(readFile(finalPath, "utf8")).resolves.toBe("Concurrent authoritative note.");
    await expect(readFile(path.join(root, job.notes[0]!.notePath), "utf8")).resolves.toContain("status: blocked");
  });

  it("recovers a promoted final file when the first staging cleanup attempt fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-sources-"));
    const source = path.join(sourceDir, "Handbook.txt");
    const finalPath = path.join(root, "00-Inbox/Imports/Handbook.md");
    await writeAutoWritePolicy(root);
    await writeFile(source, "Handbook source content.", "utf8");
    let stagingUnlinkFailed = false;

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Handbook",
      files: [source],
      now: "2026-07-29T00:00:00.000Z",
      fileOps: {
        unlink: async (targetPath) => {
          if (
            targetPath.includes("/.app/import-staging/")
            && !stagingUnlinkFailed
          ) {
            stagingUnlinkFailed = true;
            throw new Error("Staging unlink failed");
          }
          await unlink(targetPath);
        },
      },
    });

    expect(job.notes[0]).toMatchObject({
      status: "auto_written",
      notePath: "00-Inbox/Imports/Handbook.md",
      safetyDecision: { decision: "auto_write", reasonCodes: [] },
    });
    await expect(readFile(finalPath, "utf8")).resolves.toContain("Handbook source content.");
    await expect(
      readFile(path.join(root, ".app/import-staging", job.id, "Handbook.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readdir(path.join(root, ".app/import-promotion-journal")),
    ).resolves.toEqual([]);
  });
});

async function writeAutoWritePolicy(root: string): Promise<void> {
  await mkdir(path.join(root, ".vault"), { recursive: true });
  await writeFile(
    path.join(root, ".vault/routing-policy.json"),
    JSON.stringify({ rules: [{ pattern: "Handbook", category: "resource", sensitivity: "normal", destination: "00-Inbox/Imports/Handbook.md" }] }),
    "utf8",
  );
}


function frontmatterField(note: string, field: string): string {
  const match = new RegExp(`^${field}:\\s*(.+)$`, "mu").exec(note);
  return match?.[1]?.trim().replace(/^"|"$/gu, "") ?? "";
}

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
