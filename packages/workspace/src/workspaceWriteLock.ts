import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  secureEnsureWorkspaceDirectory,
  secureReadWorkspaceArtifact,
  secureRemoveWorkspaceArtifact,
  secureWriteWorkspaceFileExclusive,
  syncWorkspaceDirectory,
  type SecureWorkspaceArtifactIdentity,
  type SecureWorkspaceIoHooks,
} from "./secureWorkspaceIo";

export const workspaceWriteLockRelativePath = ".app/routing-policy.lock";

export interface WorkspaceWriteLockOptions {
  ioHooks?: SecureWorkspaceIoHooks;
  leaseMs?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface WorkspaceWriteLockClient {
  withLock<T>(
    workspaceRoot: string,
    operation: (canonicalWorkspaceRoot: string) => Promise<T>,
    options?: WorkspaceWriteLockOptions,
  ): Promise<T>;
}

interface LockRecord {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
  leaseUntil: string;
}

interface HeldLock {
  artifact: SecureWorkspaceArtifactIdentity;
  record: LockRecord;
}

const defaultLeaseMs = 60_000;
const defaultRetryDelayMs = 25;
const defaultTimeoutMs = 5_000;

export function createWorkspaceWriteLockClient(): WorkspaceWriteLockClient {
  const queues = new Map<string, Promise<void>>();
  return {
    async withLock<T>(
      workspaceRoot: string,
      operation: (canonicalWorkspaceRoot: string) => Promise<T>,
      options: WorkspaceWriteLockOptions = {},
    ): Promise<T> {
      const canonicalRoot = await realpath(workspaceRoot);
      const previous = queues.get(canonicalRoot) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(() => withFilesystemLock(canonicalRoot, operation, options));
      const tail = run.then(() => undefined, () => undefined);
      queues.set(canonicalRoot, tail);
      try {
        return await run;
      } finally {
        if (queues.get(canonicalRoot) === tail) {
          queues.delete(canonicalRoot);
        }
      }
    },
  };
}

const defaultClient = createWorkspaceWriteLockClient();

export async function withWorkspaceWriteLock<T>(
  workspaceRoot: string,
  operation: (canonicalWorkspaceRoot: string) => Promise<T>,
  options: WorkspaceWriteLockOptions = {},
): Promise<T> {
  return defaultClient.withLock(workspaceRoot, operation, options);
}

async function withFilesystemLock<T>(
  canonicalRoot: string,
  operation: (canonicalWorkspaceRoot: string) => Promise<T>,
  options: WorkspaceWriteLockOptions,
): Promise<T> {
  const held = await acquireFilesystemLock(canonicalRoot, options);
  const outcome = await operation(canonicalRoot).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await secureRemoveWorkspaceArtifact(canonicalRoot, held.artifact, {
      operation: "workspace_lock_release",
      hooks: options.ioHooks,
    });
  } catch (releaseError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, releaseError],
        "Workspace operation and lock release both failed",
      );
    }
    throw releaseError;
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

async function acquireFilesystemLock(
  canonicalRoot: string,
  options: WorkspaceWriteLockOptions,
): Promise<HeldLock> {
  const leaseMs = positiveInteger(options.leaseMs, defaultLeaseMs);
  const retryDelayMs = positiveInteger(
    options.retryDelayMs,
    defaultRetryDelayMs,
  );
  const timeoutMs = positiveInteger(options.timeoutMs, defaultTimeoutMs);
  const lockPath = path.join(canonicalRoot, workspaceWriteLockRelativePath);
  await secureEnsureWorkspaceDirectory(canonicalRoot, path.dirname(lockPath));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const createdAt = new Date();
    const record: LockRecord = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      createdAt: createdAt.toISOString(),
      leaseUntil: new Date(createdAt.getTime() + leaseMs).toISOString(),
    };
    try {
      const artifact = await secureWriteWorkspaceFileExclusive(
        canonicalRoot,
        lockPath,
        `${JSON.stringify(record)}\n`,
        {
          operation: "workspace_lock_acquire",
          hooks: options.ioHooks,
        },
      );
      await syncWorkspaceDirectory(canonicalRoot, path.dirname(lockPath));
      return { artifact, record };
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
    }

    const current = await readContendedLock(canonicalRoot, lockPath, options);
    if (
      current
      && current.record.leaseUntil.getTime() <= Date.now()
    ) {
      try {
        await secureRemoveWorkspaceArtifact(
          canonicalRoot,
          current.artifact,
          {
            operation: "workspace_lock_stale_takeover",
            hooks: options.ioHooks,
          },
        );
        continue;
      } catch {
        // Another lock client changed the lock; retry from the canonical path.
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for workspace routing lock");
    }
    await delay(retryDelayMs);
  }
}

async function readContendedLock(
  canonicalRoot: string,
  lockPath: string,
  options: WorkspaceWriteLockOptions,
): Promise<{
  artifact: SecureWorkspaceArtifactIdentity;
  record: { leaseUntil: Date };
} | undefined> {
  try {
    const snapshot = await secureReadWorkspaceArtifact(
      canonicalRoot,
      lockPath,
      {
        operation: "workspace_lock_contended_read",
        hooks: options.ioHooks,
      },
    );
    const parsed = parseLockRecord(snapshot.contents.toString("utf8"));
    return {
      artifact: snapshot.artifact,
      record: { leaseUntil: new Date(parsed.leaseUntil) },
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function parseLockRecord(raw: string): LockRecord {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object"
    || value === null
    || !("version" in value)
    || value.version !== 1
    || !("token" in value)
    || typeof value.token !== "string"
    || value.token.length === 0
    || !("pid" in value)
    || typeof value.pid !== "number"
    || !Number.isSafeInteger(value.pid)
    || !("createdAt" in value)
    || typeof value.createdAt !== "string"
    || !isIsoDate(value.createdAt)
    || !("leaseUntil" in value)
    || typeof value.leaseUntil !== "string"
    || !isIsoDate(value.leaseUntil)
  ) {
    throw new Error("Invalid workspace routing lock");
  }
  return {
    version: 1,
    token: value.token,
    pid: value.pid,
    createdAt: value.createdAt,
    leaseUntil: value.leaseUntil,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "EEXIST";
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
