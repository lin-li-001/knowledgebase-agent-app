import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "@kb-agent/storage";
import { exportLlmsFlat, indexWorkspace } from "../src/index";

let opened: AppDatabase[] = [];

afterEach(() => {
  for (const db of opened) {
    db.close();
  }
  opened = [];
});

describe("exportLlmsFlat", () => {
  it("writes note metadata to .app/exports/llms-flat.txt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-export-"));
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);

    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(
      path.join(root, "03-Knowledge/Graph Memory.md"),
      `---
title: Graph Memory
type: knowledge
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: [graph, memory]
summary: Graph memory architecture summary.
---

# Graph Memory

Body.
`,
    );
    await indexWorkspace(root, db);

    const exportPath = await exportLlmsFlat(root, db);
    const content = await readFile(exportPath, "utf8");

    expect(exportPath).toBe(path.join(root, ".app/exports/llms-flat.txt"));
    expect(content).toContain("title: Graph Memory");
    expect(content).toContain("path: 03-Knowledge/Graph Memory.md");
    expect(content).toContain("summary: Graph memory architecture summary.");
    expect(content).toContain("status: active");
    expect(content).toContain("tags: graph, memory");
  });
});
