import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  secureAtomicReplaceWorkspaceFile,
  secureEnsureWorkspaceDirectory,
  securePublishWorkspaceFileAtomic,
  secureQuarantineWorkspaceArtifact,
  secureReadWorkspaceArtifact,
  secureRemoveWorkspaceArtifact,
  secureWorkspacePathExists,
  type SecureWorkspaceArtifactIdentity,
  type SecureWorkspaceIoHooks,
} from "./secureWorkspaceIo";

export const workspaceWriteLockRelativePath = ".app/routing-policy.lock";

export interface WorkspaceWriteLockOptions {
  ioHooks?: SecureWorkspaceIoHooks;
  leaseMs?: number;
  malformedStaleMs?: number;
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
  heartbeatAt: string;
  leaseUntil: string;
}

interface HeldLock {
  artifact: SecureWorkspaceArtifactIdentity;
  record: LockRecord;
}

const defaultLeaseMs = 60_000;
const defaultMalformedStaleMs = 5 * 60_000;
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
  const leaseMs = positiveInteger(options.leaseMs, defaultLeaseMs);
  const heartbeat = startLockHeartbeat(
    canonicalRoot,
    held,
    leaseMs,
    options,
  );
  const outcome = await Promise.resolve().then(() =>
    operation(canonicalRoot)).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const heartbeatError = await heartbeat.stop();
  let releaseError: unknown;
  try {
    await releaseHeldLock(canonicalRoot, held, options);
  } catch (error) {
    releaseError = error;
  }
  const errors = [
    ...(outcome.ok ? [] : [outcome.error]),
    ...(heartbeatError === undefined ? [] : [heartbeatError]),
    ...(releaseError === undefined ? [] : [releaseError]),
  ];
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Workspace operation, heartbeat, or lock release failed",
    );
  }
  return (outcome as { ok: true; value: T }).value;
}

function startLockHeartbeat(
  canonicalRoot: string,
  held: HeldLock,
  leaseMs: number,
  options: WorkspaceWriteLockOptions,
): {
  stop(): Promise<unknown | undefined>;
} {
  const intervalMs = Math.max(5, Math.floor(leaseMs / 3));
  let heartbeatError: unknown;
  let tail = Promise.resolve();
  const timer = setInterval(() => {
    tail = tail.then(async () => {
      if (heartbeatError !== undefined) {
        return;
      }
      try {
        await renewHeldLock(canonicalRoot, held, leaseMs, options);
      } catch (error) {
        heartbeatError = error;
      }
    });
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await tail;
      return heartbeatError;
    },
  };
}

async function renewHeldLock(
  canonicalRoot: string,
  held: HeldLock,
  leaseMs: number,
  options: WorkspaceWriteLockOptions,
): Promise<void> {
  const current = await secureReadWorkspaceArtifact(
    canonicalRoot,
    held.artifact.targetPath,
    {
      operation: "workspace_lock_heartbeat_read",
      hooks: options.ioHooks,
      expectedArtifact: held.artifact,
    },
  );
  const currentRecord = parseLockRecord(current.contents.toString("utf8"));
  if (currentRecord.token !== held.record.token) {
    throw new Error("Workspace routing lock token changed");
  }
  const heartbeatAt = new Date();
  const nextRecord: LockRecord = {
    ...held.record,
    heartbeatAt: heartbeatAt.toISOString(),
    leaseUntil: new Date(heartbeatAt.getTime() + leaseMs).toISOString(),
  };
  try {
    held.artifact = await secureAtomicReplaceWorkspaceFile(
      canonicalRoot,
      held.artifact.targetPath,
      serializeLockRecord(nextRecord),
      {
        operation: "workspace_lock_heartbeat",
        hooks: options.ioHooks,
        expectedArtifact: held.artifact,
        tempToken: held.record.token,
      },
    );
    held.record = nextRecord;
  } catch (error) {
    const reconciled = await reconcilePublishedHeartbeat(
      canonicalRoot,
      held,
      options,
    );
    if (!reconciled) {
      throw error;
    }
    held.artifact = reconciled.artifact;
    held.record = reconciled.record;
  }
}

async function reconcilePublishedHeartbeat(
  canonicalRoot: string,
  held: HeldLock,
  options: WorkspaceWriteLockOptions,
): Promise<HeldLock | undefined> {
  try {
    const current = await secureReadWorkspaceArtifact(
      canonicalRoot,
      held.artifact.targetPath,
      {
        operation: "workspace_lock_heartbeat_reconcile",
        hooks: options.ioHooks,
      },
    );
    const currentRecord = parseLockRecord(current.contents.toString("utf8"));
    if (
      currentRecord.token !== held.record.token
      || sameArtifactVersion(current.artifact, held.artifact)
    ) {
      return undefined;
    }
    return { artifact: current.artifact, record: currentRecord };
  } catch {
    return undefined;
  }
}

async function releaseHeldLock(
  canonicalRoot: string,
  held: HeldLock,
  options: WorkspaceWriteLockOptions,
): Promise<void> {
  const current = await secureReadWorkspaceArtifact(
    canonicalRoot,
    held.artifact.targetPath,
    {
      operation: "workspace_lock_release_read",
      hooks: options.ioHooks,
    },
  );
  const currentRecord = parseLockRecord(current.contents.toString("utf8"));
  if (currentRecord.token !== held.record.token) {
    throw new Error("Workspace routing lock token changed before release");
  }
  await secureRemoveWorkspaceArtifact(canonicalRoot, current.artifact, {
    operation: "workspace_lock_release",
    hooks: options.ioHooks,
  });
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
  const malformedStaleMs = positiveInteger(
    options.malformedStaleMs,
    defaultMalformedStaleMs,
  );
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
      heartbeatAt: createdAt.toISOString(),
      leaseUntil: new Date(createdAt.getTime() + leaseMs).toISOString(),
    };
    try {
      const artifact = await publishLockRecord(
        canonicalRoot,
        lockPath,
        record,
        options,
      );
      return { artifact, record };
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
    }

    const current = await readContendedLock(canonicalRoot, lockPath, options);
    if (
      current?.record
      && Date.parse(current.record.leaseUntil) <= Date.now()
      && !isProcessAlive(current.record.pid)
    ) {
      try {
        await secureQuarantineWorkspaceArtifact(
          canonicalRoot,
          current.artifact,
          "stale-lock",
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
    if (
      current
      && current.record === undefined
      && Date.now() - current.mtimeMs >= malformedStaleMs
    ) {
      try {
        await secureQuarantineWorkspaceArtifact(
          canonicalRoot,
          current.artifact,
          "malformed-lock",
          {
            operation: "workspace_lock_malformed_takeover",
            hooks: options.ioHooks,
          },
        );
        continue;
      } catch {
        // Another lock client changed the malformed lock; retry.
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for workspace routing lock");
    }
    await delay(retryDelayMs);
  }
}

async function publishLockRecord(
  canonicalRoot: string,
  lockPath: string,
  record: LockRecord,
  options: WorkspaceWriteLockOptions,
): Promise<SecureWorkspaceArtifactIdentity> {
  let tempArtifact: SecureWorkspaceArtifactIdentity | undefined;
  try {
    return await securePublishWorkspaceFileAtomic(
      canonicalRoot,
      lockPath,
      serializeLockRecord(record),
      {
        operation: "workspace_lock_acquire",
        hooks: options.ioHooks,
        tempToken: record.token,
        afterTempSync: async (artifact) => {
          tempArtifact = artifact;
        },
      },
    );
  } catch (error) {
    if (
      tempArtifact
      && !isFileExistsError(error)
      && await secureWorkspacePathExists(canonicalRoot, lockPath)
    ) {
      await secureRemoveWorkspaceArtifact(
        canonicalRoot,
        {
          ...tempArtifact,
          targetPath: lockPath,
        },
        {
          operation: "workspace_lock_failed_publish",
          hooks: options.ioHooks,
        },
      ).catch(() => undefined);
    }
    if (
      tempArtifact
      && await secureWorkspacePathExists(
        canonicalRoot,
        tempArtifact.targetPath,
      )
    ) {
      await secureRemoveWorkspaceArtifact(
        canonicalRoot,
        tempArtifact,
        {
          operation: "workspace_lock_temp_cleanup",
          hooks: options.ioHooks,
        },
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function readContendedLock(
  canonicalRoot: string,
  lockPath: string,
  options: WorkspaceWriteLockOptions,
): Promise<{
  artifact: SecureWorkspaceArtifactIdentity;
  mtimeMs: number;
  record?: LockRecord;
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
    const metadata = await lstat(lockPath);
    if (
      metadata.dev !== snapshot.artifact.fileDev
      || metadata.ino !== snapshot.artifact.fileIno
    ) {
      return undefined;
    }
    let record: LockRecord | undefined;
    try {
      record = parseLockRecord(snapshot.contents.toString("utf8"));
    } catch {
      record = undefined;
    }
    return {
      artifact: snapshot.artifact,
      mtimeMs: metadata.mtimeMs,
      ...(record === undefined ? {} : { record }),
    };
  } catch (error) {
    if (isMissingPathError(error) || isTransientIdentityError(error)) {
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
    || !Number.isInteger(value.pid)
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || !("createdAt" in value)
    || typeof value.createdAt !== "string"
    || !isIsoDate(value.createdAt)
    || !("heartbeatAt" in value)
    || typeof value.heartbeatAt !== "string"
    || !isIsoDate(value.heartbeatAt)
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
    heartbeatAt: value.heartbeatAt,
    leaseUntil: value.leaseUntil,
  };
}

function serializeLockRecord(record: LockRecord): string {
  return `${JSON.stringify(record)}\n`;
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

function isTransientIdentityError(error: unknown): boolean {
  return error instanceof Error
    && /identity changed|hash changed/iu.test(error.message);
}

function sameArtifactVersion(
  left: SecureWorkspaceArtifactIdentity,
  right: SecureWorkspaceArtifactIdentity,
): boolean {
  return left.fileDev === right.fileDev
    && left.fileIno === right.fileIno
    && left.sha256 === right.sha256;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error
      && "code" in error
      && error.code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
