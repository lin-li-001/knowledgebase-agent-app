import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

export interface WorkspaceWatcherOptions {
  debounceMs?: number;
}

export interface WorkspaceWatcher {
  close(): void;
}

export function watchWorkspace(
  rootPath: string,
  onChange: () => void | Promise<void>,
  options: WorkspaceWatcherOptions = {},
): WorkspaceWatcher {
  const debounceMs = options.debounceMs ?? 750;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const watcher: FSWatcher = watch(rootPath, { recursive: true }, (_event, filename) => {
    if (closed || !shouldWatchWorkspacePath(filename?.toString())) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) void onChange();
    }, debounceMs);
  });

  return {
    close(): void {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
    },
  };
}

export function shouldWatchWorkspacePath(relativePath: string | undefined): boolean {
  if (relativePath === undefined || relativePath.length === 0) return true;
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".app" || segment === "06-Attachments" || segment === "node_modules" || segment.startsWith("."))) {
    return false;
  }
  return normalized.toLocaleLowerCase().endsWith(".md");
}
