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
