import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceWriteLockClient,
  secureAtomicReplaceWorkspaceFile,
  secureReadWorkspaceArtifact,
  secureWorkspacePathExists,
  workspaceWriteLockRelativePath,
} from "../src";

describe("workspace write lock", () => {
  it("serializes two independent clients around one read-modify-write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-workspace-lock-"));
    const targetPath = path.join(root, ".vault/routing-policy.json");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, '{"rules":[]}\n', "utf8");
    const firstClient = createWorkspaceWriteLockClient();
    const secondClient = createWorkspaceWriteLockClient();

    const appendRule = async (
      client: ReturnType<typeof createWorkspaceWriteLockClient>,
      id: string,
      pauseMs: number,
    ) => client.withLock(root, async (canonicalRoot) => {
      const canonicalTargetPath = path.join(
        canonicalRoot,
        ".vault/routing-policy.json",
      );
      const snapshot = await secureReadWorkspaceArtifact(
        canonicalRoot,
        canonicalTargetPath,
        { operation: `policy_read_${id}` },
      );
      const policy = JSON.parse(snapshot.contents.toString("utf8")) as {
        rules: Array<{ id: string }>;
      };
      await delay(pauseMs);
      policy.rules.push({ id });
      await secureAtomicReplaceWorkspaceFile(
        canonicalRoot,
        canonicalTargetPath,
        `${JSON.stringify(policy)}\n`,
        {
          operation: `policy_write_${id}`,
          expectedArtifact: snapshot.artifact,
        },
      );
    });

    await Promise.all([
      appendRule(firstClient, "first", 50),
      appendRule(secondClient, "second", 0),
    ]);

    const result = JSON.parse(await readFile(targetPath, "utf8")) as {
      rules: Array<{ id: string }>;
    };
    expect(result.rules.map((rule) => rule.id).sort()).toEqual([
      "first",
      "second",
    ]);
  });

  it("takes over an expired lease through identity-bound cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-workspace-lock-"));
    const lockPath = path.join(root, workspaceWriteLockRelativePath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        token: "expired-owner",
        pid: 123,
        createdAt: "2000-01-01T00:00:00.000Z",
        leaseUntil: "2000-01-01T00:00:01.000Z",
      })}\n`,
      "utf8",
    );
    const client = createWorkspaceWriteLockClient();
    let ran = false;

    await client.withLock(root, async () => {
      ran = true;
    }, {
      leaseMs: 1_000,
      retryDelayMs: 5,
      timeoutMs: 500,
    });

    expect(ran).toBe(true);
    await expect(secureWorkspacePathExists(root, lockPath)).resolves.toBe(false);
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
