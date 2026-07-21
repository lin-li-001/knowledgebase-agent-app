import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
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
