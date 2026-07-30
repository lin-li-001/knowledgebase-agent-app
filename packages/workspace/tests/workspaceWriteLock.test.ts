import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
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
    const alias = `${root}-alias`;
    await symlink(root, alias, "dir");
    const firstClient = createWorkspaceWriteLockClient();
    const secondClient = createWorkspaceWriteLockClient();

    const appendRule = async (
      client: ReturnType<typeof createWorkspaceWriteLockClient>,
      workspaceRoot: string,
      id: string,
      pauseMs: number,
    ) => client.withLock(workspaceRoot, async (canonicalRoot) => {
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
      appendRule(firstClient, root, "first", 50),
      appendRule(secondClient, alias, "second", 0),
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
        pid: 999_999,
        createdAt: "2000-01-01T00:00:00.000Z",
        heartbeatAt: "2000-01-01T00:00:00.000Z",
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

  it("releases the filesystem lock when an operation throws synchronously", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-workspace-lock-"));
    const firstClient = createWorkspaceWriteLockClient();
    const secondClient = createWorkspaceWriteLockClient();

    await expect(firstClient.withLock(root, () => {
      throw new Error("synchronous operation failure");
    })).rejects.toThrow("synchronous operation failure");

    let acquired = false;
    await secondClient.withLock(root, async () => {
      acquired = true;
    }, {
      retryDelayMs: 5,
      timeoutMs: 250,
    });
    expect(acquired).toBe(true);
  });

  it("does not release a replacement lock with a different identity and token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-workspace-lock-"));
    const lockPath = path.join(root, workspaceWriteLockRelativePath);
    const client = createWorkspaceWriteLockClient();
    const replacement = {
      version: 1,
      token: "replacement-owner",
      pid: process.pid,
      createdAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    };

    await expect(client.withLock(root, async () => {
      await rename(lockPath, `${lockPath}.previous-owner`);
      await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, "utf8");
    })).rejects.toThrow();

    await expect(readFile(lockPath, "utf8")).resolves.toBe(
      `${JSON.stringify(replacement)}\n`,
    );
  });

  it("does not steal a live holder after the original lease interval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-workspace-lock-"));
    const firstClient = createWorkspaceWriteLockClient();
    const secondClient = createWorkspaceWriteLockClient();
    let active = 0;
    let maxActive = 0;
    const hold = async (milliseconds: number) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(milliseconds);
      active -= 1;
    };

    const first = firstClient.withLock(root, async () => hold(140), {
      leaseMs: 45,
      retryDelayMs: 5,
      timeoutMs: 2_500,
    });
    await delay(70);
    const second = secondClient.withLock(root, async () => hold(5), {
      leaseMs: 45,
      retryDelayMs: 5,
      timeoutMs: 2_500,
    });
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
  });

  it("reconciles a heartbeat published-verify fault and releases the published lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-workspace-lock-"));
    const firstClient = createWorkspaceWriteLockClient();
    const secondClient = createWorkspaceWriteLockClient();
    let injected = false;

    await expect(firstClient.withLock(root, async () => {
      await delay(90);
    }, {
      leaseMs: 45,
      retryDelayMs: 5,
      timeoutMs: 1_000,
      ioHooks: {
        afterPathSnapshot: async (operation) => {
          if (
            operation === "workspace_lock_heartbeat_published_verify"
            && !injected
          ) {
            injected = true;
            throw new Error("heartbeat verify fault");
          }
        },
      },
    })).resolves.toBeUndefined();

    expect(injected).toBe(true);
    await expect(secondClient.withLock(root, async () => "acquired", {
      retryDelayMs: 5,
      timeoutMs: 500,
    })).resolves.toBe("acquired");
  });

  it("leaves a fresh partial lock temp untouched while acquiring a complete lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-workspace-lock-"));
    const appRoot = path.join(root, ".app");
    await mkdir(appRoot, { recursive: true });
    const activeTemp = path.join(
      appRoot,
      ".routing-policy.lock.active-token.partial.publish.tmp",
    );
    await writeFile(activeTemp, "{\"version\":1", "utf8");
    const client = createWorkspaceWriteLockClient();

    await client.withLock(root, async () => undefined);

    await expect(readFile(activeTemp, "utf8")).resolves.toBe("{\"version\":1");
  });

  it("quarantines a malformed authoritative lock only after stale mtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-workspace-lock-"));
    const lockPath = path.join(root, workspaceWriteLockRelativePath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "{\"version\":1", "utf8");
    const client = createWorkspaceWriteLockClient();

    await expect(client.withLock(root, async () => undefined, {
      malformedStaleMs: 10_000,
      retryDelayMs: 5,
      timeoutMs: 250,
    })).rejects.toThrow("Timed out waiting for workspace routing lock");

    await utimes(lockPath, new Date(0), new Date(0));
    await expect(client.withLock(root, async () => undefined, {
      malformedStaleMs: 10_000,
      retryDelayMs: 5,
      timeoutMs: 250,
    })).resolves.toBeUndefined();

    const names = await readdir(path.dirname(lockPath));
    expect(names.some((name) => (
      name.includes("routing-policy.lock")
      && name.endsWith(".malformed-lock")
    ))).toBe(true);
  });

  it.each([0, -1])(
    "quarantines an expired lock with malformed pid %s after the stale grace",
    async (pid) => {
      const root = await mkdtemp(path.join(tmpdir(), "kb-workspace-lock-"));
      const lockPath = path.join(root, workspaceWriteLockRelativePath);
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(
        lockPath,
        `${JSON.stringify({
          version: 1,
          token: `invalid-pid-${pid}`,
          pid,
          createdAt: "2000-01-01T00:00:00.000Z",
          heartbeatAt: "2000-01-01T00:00:00.000Z",
          leaseUntil: "2000-01-01T00:00:01.000Z",
        })}\n`,
        "utf8",
      );
      await utimes(lockPath, new Date(0), new Date(0));
      const client = createWorkspaceWriteLockClient();

      await expect(client.withLock(root, async () => undefined, {
        malformedStaleMs: 10,
        retryDelayMs: 5,
        timeoutMs: 500,
      })).resolves.toBeUndefined();

      const names = await readdir(path.dirname(lockPath));
      expect(names.some((name) => (
        name.includes("routing-policy.lock")
        && name.endsWith(".malformed-lock")
      ))).toBe(true);
    },
  );
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
