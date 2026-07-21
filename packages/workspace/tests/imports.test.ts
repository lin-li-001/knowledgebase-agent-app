import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
