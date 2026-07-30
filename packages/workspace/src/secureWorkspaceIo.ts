import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { assertInsideWorkspace, assertRealPathInsideWorkspace } from "./pathGuard";

export type SecureDestructivePhase =
  | "quarantine_rename"
  | "quarantine_unlink";

export interface SecureWorkspaceIoHooks {
  afterPathSnapshot?(operation: string, targetPath: string): Promise<void>;
  afterWriteChunk?(
    operation: string,
    tempPath: string,
    bytesWritten: number,
    totalBytes: number,
  ): Promise<void>;
  beforeDestructiveOperation?(
    operation: string,
    phase: SecureDestructivePhase,
    targetPath: string,
  ): Promise<void>;
}

export interface SecureWorkspacePathIdentity {
  targetPath: string;
  parentPath: string;
  parentRealPath: string;
  parentDev: number;
  parentIno: number;
  fileDev?: number;
  fileIno?: number;
}

export interface SecureWorkspaceArtifactIdentity
  extends SecureWorkspacePathIdentity {
  fileDev: number;
  fileIno: number;
  sha256: string;
  size: number;
}

export interface SecureWorkspaceFileSnapshot {
  artifact: SecureWorkspaceArtifactIdentity;
  contents: Buffer;
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

interface SecureIoOptions {
  hooks?: SecureWorkspaceIoHooks | undefined;
  operation: string;
}

interface SecureRemovalOptions extends SecureIoOptions {
  afterQuarantine?(
    artifact: SecureWorkspaceArtifactIdentity,
  ): Promise<void>;
  claimFence?: (() => Promise<void>) | undefined;
  quarantinePath?: string | undefined;
  unlinkFile?: ((targetPath: string) => Promise<void>) | undefined;
}

interface SecureAtomicWriteOptions extends SecureIoOptions {
  expectedArtifact?: SecureWorkspaceArtifactIdentity | undefined;
  requireAbsent?: boolean | undefined;
  afterTempSync?(
    artifact: SecureWorkspaceArtifactIdentity,
  ): Promise<void>;
  afterPublish?(
    artifact: SecureWorkspaceArtifactIdentity,
    tempArtifact: SecureWorkspaceArtifactIdentity,
  ): Promise<void>;
}

export async function secureCopyFileIntoWorkspace(
  workspaceRoot: string,
  sourcePath: string,
  targetPath: string,
  options: SecureIoOptions,
): Promise<SecureWorkspaceFileSnapshot> {
  const contents = await readFile(sourcePath);
  const artifact = await secureWriteWorkspaceFileExclusive(
    workspaceRoot,
    targetPath,
    contents,
    options,
  );
  return secureReadWorkspaceArtifact(
    workspaceRoot,
    targetPath,
    {
      operation: options.operation === "attachment_create"
        ? "attachment_verify"
        : `${options.operation}_verify`,
      hooks: options.hooks,
      expectedArtifact: artifact,
    },
  );
}

export async function secureReadWorkspaceArtifact(
  workspaceRoot: string,
  targetPath: string,
  options: SecureIoOptions & {
    expectedArtifact?: SecureWorkspaceArtifactIdentity | undefined;
  },
): Promise<SecureWorkspaceFileSnapshot> {
  const identity = await capturePathIdentity(workspaceRoot, targetPath, true);
  if (
    options.expectedArtifact
    && !samePathIdentity(identity, options.expectedArtifact)
  ) {
    throw new Error("Artifact identity changed during secure IO");
  }
  await options.hooks?.afterPathSnapshot?.(options.operation, identity.targetPath);
  await revalidatePathIdentity(workspaceRoot, identity, true);
  const handle = await open(
    identity.targetPath,
    constants.O_RDONLY | noFollowFlag(),
  );
  try {
    await assertHandleIdentity(handle, identity);
    await revalidatePathIdentity(workspaceRoot, identity, true);
    const contents = await handle.readFile();
    const artifact = await artifactIdentity(handle, identity, contents);
    if (
      options.expectedArtifact
      && !sameArtifactIdentity(artifact, options.expectedArtifact)
    ) {
      throw new Error(
        artifact.sha256 === options.expectedArtifact.sha256
          ? "Artifact identity changed during secure IO"
          : "Artifact hash changed during secure IO",
      );
    }
    return { artifact, contents };
  } finally {
    await handle.close();
  }
}

export async function secureReadWorkspaceFile(
  workspaceRoot: string,
  targetPath: string,
  options: SecureIoOptions,
): Promise<Buffer> {
  return (
    await secureReadWorkspaceArtifact(workspaceRoot, targetPath, options)
  ).contents;
}

export async function secureReadWorkspaceText(
  workspaceRoot: string,
  targetPath: string,
  options: SecureIoOptions,
): Promise<string> {
  return (await secureReadWorkspaceFile(workspaceRoot, targetPath, options)).toString("utf8");
}

export async function secureRewriteWorkspaceFile(
  workspaceRoot: string,
  targetPath: string,
  contents: string | Buffer,
  options: SecureIoOptions & {
    claimFence?: (() => Promise<void>) | undefined;
  },
): Promise<SecureWorkspaceArtifactIdentity> {
  const identity = await capturePathIdentity(workspaceRoot, targetPath, true);
  await options.hooks?.afterPathSnapshot?.(options.operation, identity.targetPath);
  await revalidatePathIdentity(workspaceRoot, identity, true);
  const handle = await open(
    identity.targetPath,
    constants.O_WRONLY | noFollowFlag(),
  );
  const bytes = toBuffer(contents);
  try {
    await assertHandleIdentity(handle, identity);
    await revalidatePathIdentity(workspaceRoot, identity, true);
    await options.claimFence?.();
    await handle.truncate(0);
    await writeAll(handle, bytes, options.operation, identity.targetPath, options.hooks);
    await handle.sync();
    return artifactIdentity(handle, identity, bytes);
  } finally {
    await handle.close();
  }
}

export async function secureWriteWorkspaceFileExclusive(
  workspaceRoot: string,
  targetPath: string,
  contents: string | Buffer,
  options: SecureIoOptions,
): Promise<SecureWorkspaceArtifactIdentity> {
  const normalizedTarget = assertInsideWorkspace(workspaceRoot, targetPath);
  await secureEnsureWorkspaceDirectory(
    workspaceRoot,
    path.dirname(normalizedTarget),
  );
  const identity = await capturePathIdentity(
    workspaceRoot,
    normalizedTarget,
    false,
  );
  await options.hooks?.afterPathSnapshot?.(options.operation, normalizedTarget);
  await revalidatePathIdentity(workspaceRoot, identity, false);

  const bytes = toBuffer(contents);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let createdIdentity: SecureWorkspacePathIdentity | undefined;
  try {
    handle = await open(
      normalizedTarget,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    const created = await handle.stat();
    createdIdentity = {
      ...identity,
      fileDev: created.dev,
      fileIno: created.ino,
    };
    await revalidatePathIdentity(workspaceRoot, createdIdentity, true);
    await assertHandleIdentity(handle, createdIdentity);
    await writeAll(
      handle,
      bytes,
      options.operation,
      normalizedTarget,
      options.hooks,
    );
    await handle.sync();
    const artifact = await artifactIdentity(handle, createdIdentity, bytes);
    await revalidatePathIdentity(workspaceRoot, artifact, true);
    return artifact;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (createdIdentity) {
      await cleanupCreatedArtifact(
        workspaceRoot,
        createdIdentity,
        options,
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function securePublishWorkspaceFileAtomic(
  workspaceRoot: string,
  targetPath: string,
  contents: string | Buffer,
  options: SecureAtomicWriteOptions,
): Promise<SecureWorkspaceArtifactIdentity> {
  const normalizedTarget = assertInsideWorkspace(workspaceRoot, targetPath);
  await secureEnsureWorkspaceDirectory(workspaceRoot, path.dirname(normalizedTarget));
  const parent = await captureDirectoryIdentity(
    workspaceRoot,
    path.dirname(normalizedTarget),
  );
  const bytes = toBuffer(contents);
  const tempArtifact = await writeAtomicTemp(
    workspaceRoot,
    normalizedTarget,
    bytes,
    options,
    "publish",
  );

  await options.afterTempSync?.(tempArtifact);
  await options.hooks?.afterPathSnapshot?.(options.operation, normalizedTarget);
  await revalidateDirectoryIdentity(workspaceRoot, parent);
  if (await secureWorkspacePathExists(workspaceRoot, normalizedTarget)) {
    throw fileExistsError("Destination already exists");
  }

  await link(tempArtifact.targetPath, normalizedTarget);
  await syncWorkspaceDirectory(workspaceRoot, parent.path);
  const published = await secureReadWorkspaceArtifact(
    workspaceRoot,
    normalizedTarget,
    {
      operation: `${options.operation}_published_verify`,
      expectedArtifact: {
        ...tempArtifact,
        targetPath: normalizedTarget,
      },
    },
  ).then((snapshot) => snapshot.artifact);
  await options.afterPublish?.(published, tempArtifact);
  await secureRemoveWorkspaceArtifact(workspaceRoot, tempArtifact, {
    operation: `${options.operation}_temp_cleanup`,
    hooks: options.hooks,
  });
  return published;
}

export async function secureAtomicReplaceWorkspaceFile(
  workspaceRoot: string,
  targetPath: string,
  contents: string | Buffer,
  options: SecureAtomicWriteOptions,
): Promise<SecureWorkspaceArtifactIdentity> {
  const normalizedTarget = assertInsideWorkspace(workspaceRoot, targetPath);
  await secureEnsureWorkspaceDirectory(workspaceRoot, path.dirname(normalizedTarget));
  const parent = await captureDirectoryIdentity(
    workspaceRoot,
    path.dirname(normalizedTarget),
  );
  const bytes = toBuffer(contents);
  const tempArtifact = await writeAtomicTemp(
    workspaceRoot,
    normalizedTarget,
    bytes,
    options,
    "replace",
  );

  await options.afterTempSync?.(tempArtifact);
  await options.hooks?.afterPathSnapshot?.(options.operation, normalizedTarget);
  await revalidateDirectoryIdentity(workspaceRoot, parent);
  if (options.expectedArtifact) {
    await secureReadWorkspaceArtifact(workspaceRoot, normalizedTarget, {
      operation: `${options.operation}_authority_verify`,
      expectedArtifact: options.expectedArtifact,
    });
  } else if (options.requireAbsent && await secureWorkspacePathExists(workspaceRoot, normalizedTarget)) {
    throw fileExistsError("Destination already exists");
  }

  await rename(tempArtifact.targetPath, normalizedTarget);
  await syncWorkspaceDirectory(workspaceRoot, parent.path);
  const published = await secureReadWorkspaceArtifact(
    workspaceRoot,
    normalizedTarget,
    {
      operation: `${options.operation}_published_verify`,
      expectedArtifact: {
        ...tempArtifact,
        targetPath: normalizedTarget,
      },
    },
  ).then((snapshot) => snapshot.artifact);
  await options.afterPublish?.(published, tempArtifact);
  return published;
}

export async function secureRemoveWorkspaceArtifact(
  workspaceRoot: string,
  artifact: SecureWorkspaceArtifactIdentity,
  options: SecureRemovalOptions,
): Promise<void> {
  const targetPath = assertInsideWorkspace(workspaceRoot, artifact.targetPath);
  const verified = await secureReadWorkspaceArtifact(
    workspaceRoot,
    targetPath,
    {
      operation: options.operation,
      hooks: options.hooks,
      expectedArtifact: artifact,
    },
  );
  await options.hooks?.beforeDestructiveOperation?.(
    options.operation,
    "quarantine_rename",
    targetPath,
  );
  await secureReadWorkspaceArtifact(workspaceRoot, targetPath, {
    operation: `${options.operation}_rename_fence`,
    expectedArtifact: verified.artifact,
  });
  await options.claimFence?.();

  const quarantinePath = options.quarantinePath
    ? assertInsideWorkspace(workspaceRoot, options.quarantinePath)
    : path.join(
      artifact.parentPath,
      `.${path.basename(targetPath)}.${randomUUID()}.quarantine`,
    );
  if (path.dirname(quarantinePath) !== artifact.parentPath) {
    throw new Error("Artifact quarantine must stay in its verified parent");
  }
  if (await secureWorkspacePathExists(workspaceRoot, quarantinePath)) {
    throw fileExistsError("Artifact quarantine already exists");
  }
  await rename(targetPath, quarantinePath);
  await syncWorkspaceDirectory(workspaceRoot, artifact.parentPath);
  const quarantine = await secureReadWorkspaceArtifact(
    workspaceRoot,
    quarantinePath,
    { operation: `${options.operation}_quarantine_verify` },
  );
  if (!sameFileArtifact(quarantine.artifact, artifact)) {
    throw new Error("Quarantined artifact identity changed");
  }
  await options.afterQuarantine?.(quarantine.artifact);

  await options.hooks?.beforeDestructiveOperation?.(
    options.operation,
    "quarantine_unlink",
    quarantinePath,
  );
  await revalidateOriginalParent(workspaceRoot, artifact);
  await secureReadWorkspaceArtifact(workspaceRoot, quarantinePath, {
    operation: `${options.operation}_unlink_fence`,
    expectedArtifact: quarantine.artifact,
  });
  try {
    await (options.unlinkFile ?? unlink)(quarantinePath);
    await syncWorkspaceDirectory(workspaceRoot, artifact.parentPath);
  } catch (error) {
    await restoreQuarantinedArtifact(
      workspaceRoot,
      quarantine.artifact,
      targetPath,
    ).catch(() => undefined);
    throw error;
  }
}

export async function secureQuarantineWorkspaceArtifact(
  workspaceRoot: string,
  artifact: SecureWorkspaceArtifactIdentity,
  label: string,
  options: SecureIoOptions,
): Promise<SecureWorkspaceArtifactIdentity> {
  await secureReadWorkspaceArtifact(workspaceRoot, artifact.targetPath, {
    operation: options.operation,
    hooks: options.hooks,
    expectedArtifact: artifact,
  });
  await options.hooks?.beforeDestructiveOperation?.(
    options.operation,
    "quarantine_rename",
    artifact.targetPath,
  );
  await secureReadWorkspaceArtifact(workspaceRoot, artifact.targetPath, {
    operation: `${options.operation}_rename_fence`,
    expectedArtifact: artifact,
  });
  const quarantinePath = path.join(
    artifact.parentPath,
    `.${path.basename(artifact.targetPath)}.${randomUUID()}.${label}`,
  );
  await rename(artifact.targetPath, quarantinePath);
  await syncWorkspaceDirectory(workspaceRoot, artifact.parentPath);
  const quarantined = await secureReadWorkspaceArtifact(
    workspaceRoot,
    quarantinePath,
    { operation: `${options.operation}_quarantine_verify` },
  ).then((snapshot) => snapshot.artifact);
  if (!sameFileArtifact(quarantined, artifact)) {
    throw new Error("Quarantined artifact identity changed");
  }
  return quarantined;
}

export async function secureUnlinkWorkspaceFile(
  workspaceRoot: string,
  targetPath: string,
  options: SecureRemovalOptions & {
    expectedIdentity?: SecureWorkspacePathIdentity | undefined;
  },
): Promise<void> {
  const snapshot = await secureReadWorkspaceArtifact(
    workspaceRoot,
    targetPath,
    {
      operation: `${options.operation}_capture`,
      hooks: options.hooks,
    },
  );
  if (
    options.expectedIdentity
    && !samePathIdentity(snapshot.artifact, options.expectedIdentity)
  ) {
    throw new Error("Destination identity changed before rollback");
  }
  await secureRemoveWorkspaceArtifact(workspaceRoot, snapshot.artifact, options);
}

export async function secureWorkspacePathExists(
  workspaceRoot: string,
  targetPath: string,
): Promise<boolean> {
  try {
    await capturePathIdentity(workspaceRoot, targetPath, true);
    return true;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    await captureNearestExistingDirectory(
      workspaceRoot,
      path.dirname(assertInsideWorkspace(workspaceRoot, targetPath)),
    );
    return false;
  }
}

export async function secureEnsureWorkspaceDirectory(
  workspaceRoot: string,
  targetDirectory: string,
): Promise<void> {
  const normalizedDirectory = assertInsideWorkspace(
    workspaceRoot,
    targetDirectory,
  );
  const nearestParent = await captureNearestExistingDirectory(
    workspaceRoot,
    normalizedDirectory,
  );
  await revalidateDirectoryIdentity(workspaceRoot, nearestParent);
  await mkdir(normalizedDirectory, { recursive: true });
  await revalidateDirectoryIdentity(workspaceRoot, nearestParent);
  await captureDirectoryIdentity(workspaceRoot, normalizedDirectory);
}

export async function secureReadWorkspaceDirectory(
  workspaceRoot: string,
  targetDirectory: string,
  options: SecureIoOptions,
): Promise<string[]> {
  const identity = await captureDirectoryIdentity(
    workspaceRoot,
    targetDirectory,
  );
  await options.hooks?.afterPathSnapshot?.(options.operation, identity.path);
  await revalidateDirectoryIdentity(workspaceRoot, identity);
  const entries = await readdir(identity.path);
  await revalidateDirectoryIdentity(workspaceRoot, identity);
  return entries;
}

export async function syncWorkspaceDirectory(
  workspaceRoot: string,
  targetDirectory: string,
): Promise<void> {
  const identity = await captureDirectoryIdentity(
    workspaceRoot,
    targetDirectory,
  );
  const handle = await open(identity.path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await revalidateDirectoryIdentity(workspaceRoot, identity);
}

export function sameArtifactIdentity(
  left: SecureWorkspaceArtifactIdentity,
  right: SecureWorkspaceArtifactIdentity,
): boolean {
  return samePathIdentity(left, right)
    && left.sha256 === right.sha256
    && left.size === right.size;
}

async function writeAtomicTemp(
  workspaceRoot: string,
  targetPath: string,
  contents: Buffer,
  options: SecureAtomicWriteOptions,
  kind: string,
): Promise<SecureWorkspaceArtifactIdentity> {
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.${kind}.tmp`,
  );
  return secureWriteWorkspaceFileExclusive(
    workspaceRoot,
    tempPath,
    contents,
    {
      operation: options.operation,
      hooks: options.hooks,
    },
  );
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  contents: Buffer,
  operation: string,
  targetPath: string,
  hooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  let offset = 0;
  while (offset < contents.length) {
    const remaining = contents.length - offset;
    const chunkLength = offset === 0 && remaining > 1
      ? Math.max(1, Math.floor(remaining / 2))
      : remaining;
    const { bytesWritten } = await handle.write(
      contents,
      offset,
      chunkLength,
      offset,
    );
    if (bytesWritten <= 0) {
      throw new Error("Secure write made no progress");
    }
    offset += bytesWritten;
    await hooks?.afterWriteChunk?.(
      operation,
      targetPath,
      offset,
      contents.length,
    );
  }
}

async function artifactIdentity(
  handle: Awaited<ReturnType<typeof open>>,
  identity: SecureWorkspacePathIdentity,
  contents: Buffer,
): Promise<SecureWorkspaceArtifactIdentity> {
  const file = await handle.stat();
  if (
    !file.isFile()
    || file.dev !== identity.fileDev
    || file.ino !== identity.fileIno
  ) {
    throw new Error("Path identity changed during secure IO");
  }
  return {
    ...identity,
    fileDev: file.dev,
    fileIno: file.ino,
    sha256: hashContents(contents),
    size: file.size,
  };
}

async function cleanupCreatedArtifact(
  workspaceRoot: string,
  identity: SecureWorkspacePathIdentity,
  options: SecureIoOptions,
): Promise<void> {
  const snapshot = await secureReadWorkspaceArtifact(
    workspaceRoot,
    identity.targetPath,
    {
      operation: `${options.operation}_failed_create_capture`,
      expectedArtifact: undefined,
    },
  );
  if (!samePathIdentity(snapshot.artifact, identity)) {
    return;
  }
  await secureRemoveWorkspaceArtifact(workspaceRoot, snapshot.artifact, {
    operation: `${options.operation}_failed_create_cleanup`,
    hooks: options.hooks,
  });
}

async function restoreQuarantinedArtifact(
  workspaceRoot: string,
  quarantine: SecureWorkspaceArtifactIdentity,
  targetPath: string,
): Promise<void> {
  await revalidateOriginalParent(workspaceRoot, quarantine);
  if (await secureWorkspacePathExists(workspaceRoot, targetPath)) {
    return;
  }
  await secureReadWorkspaceArtifact(workspaceRoot, quarantine.targetPath, {
    operation: "quarantine_restore_verify",
    expectedArtifact: quarantine,
  });
  await rename(quarantine.targetPath, targetPath);
  await syncWorkspaceDirectory(workspaceRoot, quarantine.parentPath);
}

async function revalidateOriginalParent(
  workspaceRoot: string,
  artifact: SecureWorkspaceArtifactIdentity,
): Promise<void> {
  await revalidateDirectoryIdentity(workspaceRoot, {
    path: artifact.parentPath,
    realPath: artifact.parentRealPath,
    dev: artifact.parentDev,
    ino: artifact.parentIno,
  });
}

function sameFileArtifact(
  left: SecureWorkspaceArtifactIdentity,
  right: SecureWorkspaceArtifactIdentity,
): boolean {
  return left.parentRealPath === right.parentRealPath
    && left.parentDev === right.parentDev
    && left.parentIno === right.parentIno
    && left.fileDev === right.fileDev
    && left.fileIno === right.fileIno
    && left.sha256 === right.sha256
    && left.size === right.size;
}

function samePathIdentity(
  left: SecureWorkspacePathIdentity,
  right: SecureWorkspacePathIdentity,
): boolean {
  return left.targetPath === right.targetPath
    && left.parentRealPath === right.parentRealPath
    && left.parentDev === right.parentDev
    && left.parentIno === right.parentIno
    && left.fileDev === right.fileDev
    && left.fileIno === right.fileIno;
}

async function captureNearestExistingDirectory(
  workspaceRoot: string,
  targetDirectory: string,
): Promise<DirectoryIdentity> {
  const normalizedDirectory = assertInsideWorkspace(
    workspaceRoot,
    targetDirectory,
  );
  await assertNoSymlinkAncestors(workspaceRoot, normalizedDirectory);
  let current = normalizedDirectory;
  while (true) {
    try {
      return await captureDirectoryIdentity(workspaceRoot, current);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function captureDirectoryIdentity(
  workspaceRoot: string,
  targetDirectory: string,
): Promise<DirectoryIdentity> {
  const normalizedDirectory = assertInsideWorkspace(
    workspaceRoot,
    targetDirectory,
  );
  await assertNoSymlinkAncestors(workspaceRoot, normalizedDirectory);
  const entry = await lstat(normalizedDirectory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Path resolves outside workspace through a symbolic link");
  }
  const resolvedPath = await realpath(normalizedDirectory);
  await assertCanonicalInsideWorkspace(workspaceRoot, resolvedPath);
  return {
    path: normalizedDirectory,
    realPath: resolvedPath,
    dev: entry.dev,
    ino: entry.ino,
  };
}

async function revalidateDirectoryIdentity(
  workspaceRoot: string,
  identity: DirectoryIdentity,
): Promise<void> {
  await assertNoSymlinkAncestors(workspaceRoot, identity.path);
  const entry = await lstat(identity.path);
  const resolvedPath = await realpath(identity.path);
  if (
    !entry.isDirectory()
    || entry.isSymbolicLink()
    || entry.dev !== identity.dev
    || entry.ino !== identity.ino
    || resolvedPath !== identity.realPath
  ) {
    throw new Error("Path identity changed during secure IO");
  }
}

async function capturePathIdentity(
  workspaceRoot: string,
  targetPath: string,
  includeFile: boolean,
): Promise<SecureWorkspacePathIdentity> {
  const normalizedTarget = assertInsideWorkspace(workspaceRoot, targetPath);
  await assertNoSymlinkAncestors(
    workspaceRoot,
    includeFile ? normalizedTarget : path.dirname(normalizedTarget),
  );
  const parentPath = path.dirname(normalizedTarget);
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("Path resolves outside workspace through a symbolic link");
  }
  const parentRealPath = await realpath(parentPath);
  await assertCanonicalInsideWorkspace(workspaceRoot, parentRealPath);
  const identity: SecureWorkspacePathIdentity = {
    targetPath: normalizedTarget,
    parentPath,
    parentRealPath,
    parentDev: parent.dev,
    parentIno: parent.ino,
  };
  if (includeFile) {
    const file = await lstat(normalizedTarget);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error("Path resolves outside workspace through a symbolic link");
    }
    identity.fileDev = file.dev;
    identity.fileIno = file.ino;
    await assertRealPathInsideWorkspace(workspaceRoot, normalizedTarget, {
      mustExist: true,
    });
  }
  return identity;
}

async function assertCanonicalInsideWorkspace(
  workspaceRoot: string,
  canonicalPath: string,
): Promise<void> {
  const canonicalRoot = await realpath(workspaceRoot);
  const relative = path.relative(canonicalRoot, canonicalPath);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Path resolves outside workspace");
  }
}

async function revalidatePathIdentity(
  workspaceRoot: string,
  identity: SecureWorkspacePathIdentity,
  includeFile: boolean,
): Promise<void> {
  await assertNoSymlinkAncestors(
    workspaceRoot,
    includeFile ? identity.targetPath : identity.parentPath,
  );
  const parent = await lstat(identity.parentPath);
  const parentRealPath = await realpath(identity.parentPath);
  if (
    !parent.isDirectory()
    || parent.isSymbolicLink()
    || parent.dev !== identity.parentDev
    || parent.ino !== identity.parentIno
    || parentRealPath !== identity.parentRealPath
  ) {
    throw new Error("Path identity changed during secure IO");
  }
  if (includeFile) {
    const file = await lstat(identity.targetPath);
    if (
      !file.isFile()
      || file.isSymbolicLink()
      || file.dev !== identity.fileDev
      || file.ino !== identity.fileIno
    ) {
      throw new Error("Path identity changed during secure IO");
    }
    await assertRealPathInsideWorkspace(
      workspaceRoot,
      identity.targetPath,
      { mustExist: true },
    );
  }
}

async function assertHandleIdentity(
  handle: Awaited<ReturnType<typeof open>>,
  identity: SecureWorkspacePathIdentity,
): Promise<void> {
  const file = await handle.stat();
  if (
    !file.isFile()
    || file.dev !== identity.fileDev
    || file.ino !== identity.fileIno
  ) {
    throw new Error("Path identity changed during secure IO");
  }
}

async function assertNoSymlinkAncestors(
  workspaceRoot: string,
  targetPath: string,
): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const target = assertInsideWorkspace(root, targetPath);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error("Path resolves outside workspace through a symbolic link");
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
  }
}

function toBuffer(contents: string | Buffer): Buffer {
  return Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
}

function hashContents(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function fileExistsError(message: string): Error {
  return Object.assign(new Error(message), { code: "EEXIST" });
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
