import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("launch desktop app and show v0.1A shell", async () => {
  const app = await electron.launch({ args: ["out/main/main.js"] });
  const window = await app.firstWindow();

  await expect(window.getByRole("button", { name: "Chat" })).toBeVisible();
  await expect(window.getByRole("button", { name: "Knowledge" })).toBeVisible();
  await expect(window.getByRole("button", { name: "Review" })).toBeVisible();
  await expect(window.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(window.getByRole("complementary", { name: "Activity" })).toBeVisible();
  await expect.poll(() => window.evaluate(() => Boolean(window.kbAgent?.invoke))).toBe(true);

  await window.getByRole("button", { name: "Settings" }).click();
  await expect(window.getByRole("button", { name: "Save Settings" })).toBeEnabled();
  await expect(window.getByRole("button", { name: "Open Workspace" })).toBeEnabled();
  await expect(window.getByRole("button", { name: "Create Workspace" })).toBeEnabled();
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "kb-agent-e2e-workspace-"));
  await window.getByLabel("Workspace Root").fill(workspaceRoot);
  await window.getByRole("button", { name: "Create Workspace" }).click();
  await expect(window.getByText(/Could not dynamically require/u)).not.toBeVisible();
  await expect(window.getByText("Workspace active")).toBeVisible();

  await app.close();
});

test("imports a PDF document through the desktop UI", async () => {
  const app = await electron.launch({ args: ["out/main/main.js"] });
  const window = await app.firstWindow();
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "kb-agent-e2e-workspace-"));
  const sourceRoot = await mkdtemp(path.join(tmpdir(), "kb-agent-e2e-import-"));
  const pdfPath = path.join(sourceRoot, "Resume-Lin Li-2026.pdf");
  await writeFile(pdfPath, minimalPdf("Resume Lin Li PDF Import Test"));

  await window.getByRole("button", { name: "Settings" }).click();
  await window.getByLabel("Workspace Root").fill(workspaceRoot);
  await window.getByRole("button", { name: "Create Workspace" }).click();
  await expect(window.getByText("Workspace active")).toBeVisible();

  await window.getByRole("button", { name: "Knowledge" }).click();
  await window.getByLabel("Batch name").fill("resume");
  await window.locator('input[type="file"]').setInputFiles(pdfPath);
  await window.getByRole("button", { name: "Import Documents" }).click();

  await expect(window.getByText("Import completed")).toBeVisible();
  await expect(readFile(path.join(workspaceRoot, "04-Resources/Imports/resume.md"), "utf8")).resolves.toContain(
    "Resume Lin Li PDF Import Test",
  );

  await app.close();
});

function minimalPdf(text: string): Buffer {
  const escapedText = text.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
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
