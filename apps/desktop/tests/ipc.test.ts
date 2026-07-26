import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CostEstimate, ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent } from "@kb-agent/model";
import { appendMessage } from "@kb-agent/storage";
import { allowedChannels, handleIpcRequest, isAllowedChannel, restoreWorkspaceFromSettings, type IpcServices } from "../electron/ipc";
import { readDesktopSettings } from "../electron/secureSettings";

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

  it("writes sanitized IPC debug logs without secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    const settingsPath = path.join(root, ".desktop/settings.json");
    const debugLogPath = path.join(root, ".desktop/debug.log");
    const services: IpcServices = {
      activeTurns: new Set(),
      settingsPath,
      debugLogPath,
    };

    await expect(
      handleIpcRequest(services, "settings:update", { apiKey: "sk-secret-value", modelName: "gpt-test" }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    await expect(readFile(debugLogPath, "utf8")).resolves.toContain("\"channel\":\"settings:update\"");
    await expect(readFile(debugLogPath, "utf8")).resolves.toContain("\"ok\":true");
    await expect(readFile(debugLogPath, "utf8")).resolves.not.toContain("sk-secret-value");
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

  it("persists the active workspace and restores it for a fresh app session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    const settingsPath = path.join(root, ".desktop/settings.json");
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");

    const firstSession: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath,
    };
    opened.push(firstSession);

    await expect(handleIpcRequest(firstSession, "workspace:open", { rootPath: root })).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    await expect(readDesktopSettings(settingsPath)).resolves.toEqual(expect.objectContaining({ workspaceRoot: root }));

    const nextSession: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath,
    };
    opened.push(nextSession);

    await expect(restoreWorkspaceFromSettings(nextSession)).resolves.toBe(true);
    await expect(handleIpcRequest(nextSession, "workspace:get-active", {})).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ rootPath: root }),
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

  it("handles model session search tool calls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");

    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
      modelProvider: new ToolCallingProvider("search_sessions", "{\"query\":\"2018\"}"),
    };
    opened.push(services);
    await handleIpcRequest(services, "workspace:open", { rootPath: root });
    await appendMessage(services.db!, {
      id: "seed-message-2018",
      sessionId: services.sessionId!,
      role: "user",
      content: "I worked at Acme in 2018",
      createdAt: new Date().toISOString(),
    });

    await expect(
      handleIpcRequest(services, "chat:run-turn", { sessionId: services.sessionId, message: "where did I work in 2018" }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          events: expect.not.arrayContaining([expect.objectContaining({ type: "error" })]),
        }),
      }),
    );
  });

  it("stores reflection source context on review proposals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");

    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
      modelProvider: new ScriptedProvider([
        { content: "Nice to meet you, Lin Li." },
        {
          content: "",
          toolCalls: [
            {
              id: "review-call-1",
              name: "propose_memory",
              argumentsJson: JSON.stringify({
                body: "User's name is Lin Li.",
                source: {
                  origin: "turn_reflection",
                  userMessage: "hello my name is lin li",
                  assistantMessage: "Nice to meet you, Lin Li.",
                  reason: "Stable personal identity fact.",
                },
              }),
            },
          ],
        },
      ]),
    };
    opened.push(services);
    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    await expect(
      handleIpcRequest(services, "chat:run-turn", { sessionId: services.sessionId, message: "hello my name is lin li" }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    await expect(handleIpcRequest(services, "review:list", {})).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: [
          expect.objectContaining({
            proposalType: "propose_memory",
            payload: expect.objectContaining({
              body: "User's name is Lin Li.",
              source: expect.objectContaining({
                origin: "turn_reflection",
                userMessage: "hello my name is lin li",
                assistantMessage: "Nice to meet you, Lin Li.",
                reason: "Stable personal identity fact.",
              }),
            }),
          }),
        ],
      }),
    );
  });

  it("deduplicates repeated memory proposals for the same fact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");

    const duplicateMemory = {
      body: "User's name is Lin Li.",
      source: {
        origin: "turn_reflection",
        userMessage: "hello my name is lin li",
        assistantMessage: "Nice to meet you, Lin Li.",
        reason: "Stable personal identity fact.",
      },
    };
    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
      modelProvider: new ScriptedProvider([
        {
          content: "",
          toolCalls: [{ id: "main-call-1", name: "propose_memory", argumentsJson: JSON.stringify(duplicateMemory) }],
        },
        { content: "Nice to meet you, Lin Li." },
        {
          content: "",
          toolCalls: [{ id: "review-call-1", name: "propose_memory", argumentsJson: JSON.stringify(duplicateMemory) }],
        },
      ]),
    };
    opened.push(services);
    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    await expect(
      handleIpcRequest(services, "chat:run-turn", { sessionId: services.sessionId, message: "hello my name is lin li" }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(services.db?.sqlite.prepare("SELECT COUNT(*) as count FROM review_items").get()).toEqual({ count: 1 });
  });

  it("skips memory proposals that already exist in durable memory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "02-Profiles/default"), { recursive: true });
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeFile(
      path.join(root, "02-Profiles/default/Memory.md"),
      `---
title: Default Memory
type: memory
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

# Default Memory

- User's name is Lin Li.
`,
      "utf8",
    );
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");

    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
      modelProvider: new ScriptedProvider([
        { content: "Nice to meet you, Lin Li." },
        {
          content: "",
          toolCalls: [
            {
              id: "review-call-1",
              name: "propose_memory",
              argumentsJson: JSON.stringify({
                body: "User's name is Lin Li.",
                source: {
                  origin: "turn_reflection",
                  userMessage: "hello my name is lin li",
                  assistantMessage: "Nice to meet you, Lin Li.",
                  reason: "Stable personal identity fact.",
                },
              }),
            },
          ],
        },
      ]),
    };
    opened.push(services);
    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    await expect(
      handleIpcRequest(services, "chat:run-turn", { sessionId: services.sessionId, message: "hello my name is lin li" }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(services.db?.sqlite.prepare("SELECT COUNT(*) as count FROM review_items").get()).toEqual({ count: 0 });
  });

  it("treats repeated review approvals as idempotent", async () => {
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
    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    const now = new Date().toISOString();
    services.db?.sqlite
      .prepare(
        `INSERT INTO review_items (
          id, workspace_id, state, risk, proposal_type, payload_json, reason,
          source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("review-1", services.workspaceId, "proposed", "high", "propose_memory", "{\"body\":\"Remember Lin\"}", "reason", services.sessionId, "turn-1", now);

    await expect(handleIpcRequest(services, "review:approve", { id: "review-1" })).resolves.toEqual(
      { ok: true, data: { id: "review-1", state: "applied" } },
    );
    await expect(handleIpcRequest(services, "review:approve", { id: "review-1" })).resolves.toEqual(
      { ok: true, data: { id: "review-1", state: "applied" } },
    );
  });

  it("applies approved memory proposals to the default memory note", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "02-Profiles/default"), { recursive: true });
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeFile(
      path.join(root, "02-Profiles/default/Memory.md"),
      `---
title: Default Memory
type: memory
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

# Default Memory

Existing memory.
`,
      "utf8",
    );
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

    const now = new Date().toISOString();
    services.db?.sqlite
      .prepare(
        `INSERT INTO review_items (
          id, workspace_id, state, risk, proposal_type, payload_json, reason,
          source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("review-memory-1", services.workspaceId, "proposed", "high", "propose_memory", "{\"body\":\"User's name is Lin Li.\"}", "reason", services.sessionId, "turn-1", now);

    await expect(handleIpcRequest(services, "review:approve", { id: "review-memory-1" })).resolves.toEqual(
      { ok: true, data: { id: "review-memory-1", state: "applied" } },
    );

    await expect(readFile(path.join(root, "02-Profiles/default/Memory.md"), "utf8")).resolves.toContain(
      "- User's name is Lin Li.",
    );
  });

  it("imports local documents into attachments and a summary note", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-import-sources-"));
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeFile(path.join(sourceDir, "2026-01 Electric.txt"), "Electric bill January 2026\nAmount: $123.45\n", "utf8");
    await writeFile(path.join(sourceDir, "2026-02 Water.txt"), "Water bill February 2026\nAmount: $67.89\n", "utf8");
    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
    };
    opened.push(services);
    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    await expect(
      handleIpcRequest(services, "import:start", {
        batchName: "2026 Utility Bills",
        filePaths: [
          path.join(sourceDir, "2026-01 Electric.txt"),
          path.join(sourceDir, "2026-02 Water.txt"),
        ],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          state: "completed",
          summaryNotePath: "04-Resources/Imports/2026 Utility Bills.md",
        }),
      }),
    );

    await expect(readFile(path.join(root, "04-Resources/Imports/2026 Utility Bills.md"), "utf8")).resolves.toContain(
      "Electric bill January 2026",
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

class ToolCallingProvider implements ModelProvider {
  readonly supportsToolCalling = true;
  readonly supportsPromptCache = false;
  private callCount = 0;

  constructor(private readonly toolName: string, private readonly argumentsJson: string) {}

  async complete(): Promise<ModelResponse> {
    this.callCount += 1;
    if (this.callCount % 2 === 1) {
      return {
        content: "",
        toolCalls: [{ id: `call-${this.callCount}`, name: this.toolName, argumentsJson: this.argumentsJson }],
      };
    }

    return { content: "Session search complete." };
  }

  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "message", content: "Session search complete." };
  }

  async estimateCost(): Promise<CostEstimate> {
    return { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  }
}

class ScriptedProvider implements ModelProvider {
  readonly supportsToolCalling = true;
  readonly supportsPromptCache = false;
  private cursor = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(_input: ModelRequest): Promise<ModelResponse> {
    return this.responses[this.cursor++] ?? { content: "" };
  }

  async *stream(input: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: await this.complete(input) };
  }

  async estimateCost(): Promise<CostEstimate> {
    return { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  }
}
