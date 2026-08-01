import { describe, expect, it } from "vitest";
import { shouldWatchWorkspacePath } from "../src/workspaceWatcher";

describe("workspace watcher paths", () => {
  it("watches Markdown files and excludes runtime or attachment paths", () => {
    expect(shouldWatchWorkspacePath("03-Knowledge/Note.md")).toBe(true);
    expect(shouldWatchWorkspacePath("03-Knowledge/Note.MD")).toBe(true);
    expect(shouldWatchWorkspacePath(".app/index.sqlite")).toBe(false);
    expect(shouldWatchWorkspacePath("06-Attachments/Imports/source.pdf")).toBe(false);
    expect(shouldWatchWorkspacePath(".obsidian/workspace.json")).toBe(false);
    expect(shouldWatchWorkspacePath("03-Knowledge/Note.txt")).toBe(false);
  });
});
