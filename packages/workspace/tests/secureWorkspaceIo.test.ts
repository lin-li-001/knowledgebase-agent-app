import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  secureRemoveWorkspaceArtifact,
  secureWriteWorkspaceFileExclusive,
} from "../src/index";

describe("secure workspace artifact removal", () => {
  it("preserves replacement content when cleanup no longer owns the path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-secure-io-"));
    const targetPath = path.join(root, ".app/import-staging/import-1/Source.md");
    const created = await secureWriteWorkspaceFileExclusive(
      root,
      targetPath,
      "transaction-owned",
      { operation: "test_create" },
    );
    await unlink(targetPath);
    await writeFile(targetPath, "replacement-owned-elsewhere", "utf8");

    await expect(secureRemoveWorkspaceArtifact(root, created, {
      operation: "test_cleanup",
    })).rejects.toThrow(/identity changed|hash changed/iu);
    await expect(readFile(targetPath, "utf8")).resolves.toBe(
      "replacement-owned-elsewhere",
    );
  });

  it("does not touch outside content when the parent swaps before quarantine rename", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-secure-io-"));
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-secure-io-outside-"));
    const parent = path.join(root, ".app/import-staging/import-1");
    const targetPath = path.join(parent, "Source.md");
    await mkdir(parent, { recursive: true });
    await writeFile(path.join(outside, "Source.md"), "outside-authority", "utf8");
    const created = await secureWriteWorkspaceFileExclusive(
      root,
      targetPath,
      "transaction-owned",
      { operation: "test_create" },
    );

    await expect(secureRemoveWorkspaceArtifact(root, created, {
      operation: "test_cleanup",
      hooks: {
        beforeDestructiveOperation: async (_operation, phase) => {
          if (phase === "quarantine_rename") {
            await rename(parent, `${parent}.verified`);
            await symlink(outside, parent, "dir");
          }
        },
      },
    })).rejects.toThrow(/identity changed|symbolic link|outside workspace/iu);
    await expect(readFile(path.join(outside, "Source.md"), "utf8")).resolves.toBe(
      "outside-authority",
    );
  });

  it("leaves quarantine in place when the parent swaps before final unlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-secure-io-"));
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-secure-io-outside-"));
    const parent = path.join(root, ".app/import-staging/import-1");
    const targetPath = path.join(parent, "Source.md");
    await mkdir(parent, { recursive: true });
    await writeFile(path.join(outside, "Source.md"), "outside-authority", "utf8");
    const created = await secureWriteWorkspaceFileExclusive(
      root,
      targetPath,
      "transaction-owned",
      { operation: "test_create" },
    );

    await expect(secureRemoveWorkspaceArtifact(root, created, {
      operation: "test_cleanup",
      hooks: {
        beforeDestructiveOperation: async (_operation, phase) => {
          if (phase === "quarantine_unlink") {
            await rename(parent, `${parent}.verified`);
            await symlink(outside, parent, "dir");
          }
        },
      },
    })).rejects.toThrow(/identity changed|symbolic link|outside workspace/iu);
    await expect(readFile(path.join(outside, "Source.md"), "utf8")).resolves.toBe(
      "outside-authority",
    );
  });
});
