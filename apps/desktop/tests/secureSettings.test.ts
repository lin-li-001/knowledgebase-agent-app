import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemorySecretStore, loadApiKey, saveApiKey } from "../electron/secureSettings";

describe("secure settings", () => {
  it("stores only the key alias in settings and keeps the secret in the secret store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-settings-"));
    const settingsPath = path.join(root, ".app/settings.json");
    const store = createMemorySecretStore();

    await saveApiKey(settingsPath, "sk-test-secret", store);

    await expect(loadApiKey(settingsPath, store)).resolves.toBe("sk-test-secret");
    await expect(readFile(settingsPath, "utf8")).resolves.toContain("openai:default");
    await expect(readFile(settingsPath, "utf8")).resolves.not.toContain("sk-test-secret");
  });

  it("shares the default in-process secret store between save and load", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-settings-"));
    const settingsPath = path.join(root, ".app/settings.json");

    await saveApiKey(settingsPath, "sk-default-secret");

    await expect(loadApiKey(settingsPath)).resolves.toBe("sk-default-secret");
    await expect(readFile(settingsPath, "utf8")).resolves.not.toContain("sk-default-secret");
  });
});
