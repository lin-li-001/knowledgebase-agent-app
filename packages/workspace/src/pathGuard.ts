import { realpath } from "node:fs/promises";
import path from "node:path";

export function assertInsideWorkspace(rootPath: string, targetPath: string): string {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(normalizedRoot, targetPath);
  const relativePath = path.relative(normalizedRoot, normalizedTarget);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Path escapes workspace");
  }

  return normalizedTarget;
}

export async function assertRealPathInsideWorkspace(
  rootPath: string,
  targetPath: string,
  options: { mustExist?: boolean } = {},
): Promise<string> {
  const lexicalTarget = assertInsideWorkspace(rootPath, targetPath);
  const realRoot = await realpath(path.resolve(rootPath));
  let existingPath = lexicalTarget;

  while (true) {
    try {
      const resolvedExistingPath = await realpath(existingPath);
      assertResolvedInside(realRoot, resolvedExistingPath);
      if (options.mustExist && existingPath !== lexicalTarget) {
        throw new Error("Path does not exist");
      }
      return lexicalTarget;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      if (options.mustExist) {
        throw error;
      }
      const parent = path.dirname(existingPath);
      if (parent === existingPath) {
        throw error;
      }
      existingPath = parent;
    }
  }
}

function assertResolvedInside(realRoot: string, resolvedPath: string): void {
  const relativePath = path.relative(realRoot, resolvedPath);
  if (
    relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error("Path resolves outside workspace");
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
