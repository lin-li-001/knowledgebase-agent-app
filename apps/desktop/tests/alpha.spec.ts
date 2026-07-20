import { test, expect, _electron as electron } from "@playwright/test";

test("launch desktop app and show v0.1A shell", async () => {
  const app = await electron.launch({ args: ["out/main/main.js"] });
  const window = await app.firstWindow();

  await expect(window.getByRole("button", { name: "Chat" })).toBeVisible();
  await expect(window.getByRole("button", { name: "Knowledge" })).toBeVisible();
  await expect(window.getByRole("button", { name: "Review" })).toBeVisible();
  await expect(window.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(window.getByRole("complementary", { name: "Activity" })).toBeVisible();

  await app.close();
});
