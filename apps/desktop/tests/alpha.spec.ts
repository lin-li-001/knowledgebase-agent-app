import { test, expect, _electron as electron } from "@playwright/test";

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

  await app.close();
});
