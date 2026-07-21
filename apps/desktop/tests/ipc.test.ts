import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CostEstimate, ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent } from "@kb-agent/model";
import { allowedChannels, handleIpcRequest, isAllowedChannel, type IpcServices } from "../electron/ipc";

const opened: IpcServices[] = [];

afterEach(() => {
  for (const service of opened) {
    service.db?.close();
  }
  opened.length = 0;
});

describe("IPC contract", () => {
  it("does not expose unknown channels", () => {
    expect(allowedChannels).not.toContain("shell:exec");
    expect(isAllowedChannel("shell:exec")).toBe(false);
  });

  it("rejects notes:read paths that escape the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "00-Inbox"), { recursive: true });
    await writeFile(path.join(root, "00-Inbox/Note.md"), "hello", "utf8");
    const services: IpcServices = { workspaceRoot: root, activeTurns: new Set() };

    await expect(handleIpcRequest(services, "notes:read", { path: "00-Inbox/Note.md" })).resolves.toEqual(
      { ok: true, data: { path: "00-Inbox/Note.md", content: "hello" } },
    );
    await expect(handleIpcRequest(services, "notes:read", { path: "../outside.md" })).resolves.toEqual(
      { ok: false, error: "Path escapes workspace" },
    );
  });

  it("cancels an active chat turn", async () => {
    const services: IpcServices = { activeTurns: new Set(["session-1"]) };

    await expect(handleIpcRequest(services, "chat:cancel-turn", { sessionId: "session-1" })).resolves.toEqual(
      { ok: true, data: { interrupted: true } },
    );
    expect(services.activeTurns.has("session-1")).toBe(false);
  });

  it("opens a workspace, searches notes, and runs a chat turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");

    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
    };
    opened.push(services);

    const openResult = await handleIpcRequest(services, "workspace:open", { rootPath: root });
    expect(openResult).toEqual(expect.objectContaining({ ok: true }));
    expect(services.workspaceId).toBeTruthy();
    expect(services.sessionId).toBeTruthy();

    await expect(handleIpcRequest(services, "notes:search", { query: "memory" })).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.arrayContaining([expect.objectContaining({ title: "Graph Memory" })]),
      }),
    );

    await expect(
      handleIpcRequest(services, "chat:run-turn", { sessionId: services.sessionId, message: "Find memory" }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          events: expect.arrayContaining([expect.objectContaining({ type: "message" })]),
        }),
      }),
    );
  });

  it("returns chat error events instead of silently dropping model failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");

    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
      modelProvider: new FailingProvider("bad model"),
    };
    opened.push(services);

    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    await expect(
      handleIpcRequest(services, "chat:run-turn", { sessionId: services.sessionId, message: "Find memory" }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          events: expect.arrayContaining([expect.objectContaining({ type: "error", error: "bad model" })]),
        }),
      }),
    );
  });
});

async function writeNote(filePath: string, title: string, body: string): Promise<void> {
  await writeFile(
    filePath,
    `---
title: ${title}
type: knowledge
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: [test]
---

# ${title}

${body}
`,
    "utf8",
  );
}

class FailingProvider implements ModelProvider {
  readonly supportsToolCalling = true;
  readonly supportsPromptCache = false;

  constructor(private readonly message: string) {}

  async complete(_input: ModelRequest): Promise<ModelResponse> {
    throw new Error(this.message);
  }

  async *stream(_input: ModelRequest): AsyncIterable<ModelStreamEvent> {
    throw new Error(this.message);
  }

  async estimateCost(): Promise<CostEstimate> {
    return { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  }
}
