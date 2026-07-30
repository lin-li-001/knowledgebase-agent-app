import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { assertInsideWorkspace, assertRealPathInsideWorkspace } from "./pathGuard";

export interface SecureWorkspaceIoHooks {
  afterPathSnapshot?(operation: string, targetPath: string): Promise<void>;
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

export async function secureCopyFileIntoWorkspace(
  workspaceRoot: string,
  sourcePath: string,
  targetPath: string,
  options: SecureIoOptions,
): Promise<SecureWorkspacePathIdentity> {
  const contents = await readFile(sourcePath);
  return secureWriteWorkspaceFileExclusive(
    workspaceRoot,
    targetPath,
    contents,
    options,
  );
}

export async function secureReadWorkspaceFile(
  workspaceRoot: string,
  targetPath: string,
  options: SecureIoOptions,
): Promise<Buffer> {
  const identity = await capturePathIdentity(workspaceRoot, targetPath, true);
  await options.hooks?.afterPathSnapshot?.(options.operation, targetPath);
  await revalidatePathIdentity(workspaceRoot, identity, true);
  const handle = await open(
    identity.targetPath,
    constants.O_RDONLY | noFollowFlag(),
  );
  try {
    await assertHandleIdentity(handle, identity);
    await revalidatePathIdentity(workspaceRoot, identity, true);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
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
): Promise<void> {
  const identity = await capturePathIdentity(workspaceRoot, targetPath, true);
  await options.hooks?.afterPathSnapshot?.(options.operation, targetPath);
  await revalidatePathIdentity(workspaceRoot, identity, true);
  const handle = await open(
    identity.targetPath,
    constants.O_WRONLY | noFollowFlag(),
  );
  try {
    await assertHandleIdentity(handle, identity);
    await revalidatePathIdentity(workspaceRoot, identity, true);
    await options.claimFence?.();
    await handle.truncate(0);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await revalidatePathIdentity(workspaceRoot, identity, true);
}

export async function secureWriteWorkspaceFileExclusive(
  workspaceRoot: string,
  targetPath: string,
  contents: string | Buffer,
  options: SecureIoOptions,
): Promise<SecureWorkspacePathIdentity> {
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

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let wroteContent = false;
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
    await handle.writeFile(contents);
    wroteContent = true;
    await handle.sync();
    await revalidatePathIdentity(workspaceRoot, createdIdentity, true);
  } catch (error) {
    if (handle && !wroteContent) {
      await removeVerifiedEmptyCreatedFile(
        workspaceRoot,
        normalizedTarget,
        handle,
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  if (!createdIdentity) {
    throw new Error("Destination identity was not captured");
  }
  return createdIdentity;
}

export async function secureUnlinkWorkspaceFile(
  workspaceRoot: string,
  targetPath: string,
  options: SecureIoOptions & {
    claimFence?: (() => Promise<void>) | undefined;
    expectedIdentity?: SecureWorkspacePathIdentity | undefined;
    unlinkFile?: ((targetPath: string) => Promise<void>) | undefined;
  },
): Promise<void> {
  const identity = await capturePathIdentity(workspaceRoot, targetPath, true);
  if (
    options.expectedIdentity
    && !samePathIdentity(identity, options.expectedIdentity)
  ) {
    throw new Error("Destination identity changed before rollback");
  }
  await options.hooks?.afterPathSnapshot?.(options.operation, targetPath);
  await revalidatePathIdentity(workspaceRoot, identity, true);
  await options.claimFence?.();
  await (options.unlinkFile ?? unlink)(identity.targetPath);
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

async function removeVerifiedEmptyCreatedFile(
  workspaceRoot: string,
  targetPath: string,
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const opened = await handle.stat();
  if (opened.size !== 0) {
    return;
  }
  const canonicalPath = await realpath(targetPath);
  const canonical = await lstat(canonicalPath);
  if (
    canonical.isSymbolicLink()
    || canonical.dev !== opened.dev
    || canonical.ino !== opened.ino
    || canonical.size !== 0
  ) {
    return;
  }
  await assertCanonicalInsideWorkspace(workspaceRoot, canonicalPath);
  await unlink(canonicalPath);
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
