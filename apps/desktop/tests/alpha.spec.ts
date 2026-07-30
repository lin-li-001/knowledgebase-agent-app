import { test, expect, _electron as electron, type Locator } from "@playwright/test";
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("launch desktop app and show v0.1A shell", async () => {
  const app = await launchTestApp();
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
  await setInputValue(window.getByLabel("Workspace Root"), workspaceRoot);
  await window.getByRole("button", { name: "Create Workspace" }).click();
  await expect(window.getByText(/Could not dynamically require/u)).not.toBeVisible();
  await expect(window.getByText("Workspace active")).toBeVisible();

  await app.close();
});

test("imports a PDF document through the desktop UI", async () => {
  const app = await launchTestApp();
  const window = await app.firstWindow();
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "kb-agent-e2e-workspace-"));
  const sourceRoot = await mkdtemp(path.join(tmpdir(), "kb-agent-e2e-import-"));
  const pdfPath = path.join(sourceRoot, "Generic-Document.pdf");
  await writeFile(pdfPath, minimalPdf("Generic PDF Import Test"));

  await window.getByRole("button", { name: "Settings" }).click();
  await setInputValue(window.getByLabel("Workspace Root"), workspaceRoot);
  await window.getByRole("button", { name: "Create Workspace" }).click();
  await expect(window.getByText("Workspace active")).toBeVisible();

  await window.getByRole("button", { name: "Knowledge" }).click();
  await window.getByLabel("Batch name").fill("generic");
  await window.locator('input[type="file"]').setInputFiles(pdfPath);
  await window.getByRole("button", { name: "Import Documents" }).click();

  await expect(window.getByText("Import completed")).toBeVisible();
  const stagingRoot = path.join(workspaceRoot, ".app/import-staging");
  const [jobDirectory] = await readdir(stagingRoot);
  const [stagedNote] = await readdir(path.join(stagingRoot, jobDirectory));
  await expect(readFile(path.join(stagingRoot, jobDirectory, stagedNote), "utf8")).resolves.toContain("Generic PDF Import Test");
  await expect(readFile(path.join(workspaceRoot, "04-Resources/Imports/generic.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  await window.getByRole("button", { name: "Review" }).click();
  await expect(window.getByText("Category: unknown", { exact: true })).toBeVisible();
  await expect(window.getByText("Reasons: CLASSIFICATION_UNKNOWN", { exact: true })).toBeVisible();

  await app.close();
});

test("restores the saved workspace on the next desktop launch", async () => {
  const userDataPath = await mkdtemp(path.join(tmpdir(), "kb-agent-e2e-user-data-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "kb-agent-e2e-workspace-"));

  const firstApp = await launchTestApp(userDataPath);
  const firstWindow = await firstApp.firstWindow();
  await firstWindow.getByRole("button", { name: "Settings" }).click();
  await setInputValue(firstWindow.getByLabel("Workspace Root"), workspaceRoot);
  await firstWindow.getByRole("button", { name: "Create Workspace" }).click();
  await expect(firstWindow.getByText("Workspace active")).toBeVisible();
  await firstApp.close();

  const nextApp = await launchTestApp(userDataPath);
  const nextWindow = await nextApp.firstWindow();
  await expect(nextWindow.getByText("Workspace active").first()).toBeVisible();
  await nextWindow.getByRole("button", { name: "Settings" }).click();
  await expect(nextWindow.getByLabel("Workspace Root")).toHaveValue(
    await realpath(workspaceRoot),
  );
  await nextApp.close();
});

async function launchTestApp(userDataPath?: string) {
  return electron.launch({
    args: ["out/main/main.js"],
    env: {
      ...process.env,
      KB_AGENT_USER_DATA_PATH: userDataPath ?? (await mkdtemp(path.join(tmpdir(), "kb-agent-e2e-user-data-"))),
    },
  });
}

async function setInputValue(locator: Locator, value: string) {
  await locator.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

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
