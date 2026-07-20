import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider } from "@kb-agent/model";
import { openAppDatabase, type AppDatabase } from "@kb-agent/storage";
import { indexWorkspace, workspaceIdForRoot } from "@kb-agent/workspace";
import { runTurn, type ToolHandler } from "../src/index";

let opened: AppDatabase[] = [];

afterEach(() => {
  for (const db of opened) {
    db.close();
  }
  opened = [];
});

describe("runTurn", () => {
  it("persists user message, tool result, assistant answer, and activity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-turn-"));
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(
      path.join(root, "AGENTS.md"),
      "# Workspace Contract\n\nUse local notes.",
    );
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
tags: [graph]
---

# Graph Memory

Graph memory architecture
`,
    );

    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);
    const { workspaceId } = await indexWorkspace(root, db);
    db.sqlite
      .prepare("INSERT INTO sessions (id, workspace_id, profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("session-1", workspaceIdForRoot(root), "default", "Chat", "2026-07-20", "2026-07-20");

    const provider = new MockProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "search_notes", argumentsJson: "{\"query\":\"memory\"}" }],
      },
      { role: "assistant", content: "Graph memory is indexed." },
    ]);
    const handlers = new Map<string, ToolHandler>([
      ["search_notes", async () => [{ title: "Graph Memory" }]],
    ]) as Parameters<typeof runTurn>[0]["handlers"];

    const events = [];
    for await (const event of runTurn({
      db,
      modelProvider: provider,
      model: "mock",
      workspaceId,
      workspaceRoot: root,
      sessionId: "session-1",
      userMessage: "Find memory",
      handlers,
      now: "2026-07-20T00:00:00.000Z",
    })) {
      events.push(event);
    }

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "done" })]));
    expect(db.sqlite.prepare("SELECT COUNT(*) as count FROM messages").get()).toEqual({ count: 3 });
    expect(db.sqlite.prepare("SELECT COUNT(*) as count FROM activity_events").get()).toEqual({ count: 1 });
  });
});
