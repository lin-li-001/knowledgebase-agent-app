import { mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CostEstimate, ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent } from "@kb-agent/model";
import { appendMessage } from "@kb-agent/storage";
import { parseMarkdownNote } from "@kb-agent/workspace";
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

  it("lists workspace files and reads previewable files through guarded IPC", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "01-Projects/Demo"), { recursive: true });
    await mkdir(path.join(root, ".app"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeFile(path.join(root, "01-Projects/Demo/Plan.md"), "# Plan\n\nBuild a workspace explorer.", "utf8");
    await writeFile(path.join(root, ".app/index.sqlite"), "runtime", "utf8");
    await writeFile(path.join(root, ".git/config"), "runtime", "utf8");

    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
    };
    opened.push(services);
    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    await expect(handleIpcRequest(services, "workspace:tree", {})).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          name: path.basename(root),
          type: "directory",
          children: expect.arrayContaining([
            expect.objectContaining({
              name: "01-Projects",
              children: expect.arrayContaining([
                expect.objectContaining({
                  name: "Demo",
                  children: expect.arrayContaining([
                    expect.objectContaining({ name: "Plan.md", path: "01-Projects/Demo/Plan.md", type: "file" }),
                  ]),
                }),
              ]),
            }),
            expect.objectContaining({ name: "AGENTS.md", path: "AGENTS.md", type: "file" }),
          ]),
        }),
      }),
    );
    const treeResult = await handleIpcRequest(services, "workspace:tree", {});
    expect(JSON.stringify(treeResult)).not.toContain(".app");
    expect(JSON.stringify(treeResult)).not.toContain(".git");

    await expect(handleIpcRequest(services, "workspace:read-file", { path: "01-Projects/Demo/Plan.md" })).resolves.toEqual(
      { ok: true, data: { path: "01-Projects/Demo/Plan.md", content: "# Plan\n\nBuild a workspace explorer.", previewType: "text" } },
    );
    await expect(handleIpcRequest(services, "workspace:read-file", { path: "../outside.md" })).resolves.toEqual(
      { ok: false, error: "Path escapes workspace" },
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

  it("applies approved memory proposals to the active profile memory note", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "02-Profiles/lin"), { recursive: true });
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await mkdir(path.join(root, ".app"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeFile(path.join(root, ".app/settings.json"), JSON.stringify({ activeProfileId: "lin" }), "utf8");
    await writeFile(
      path.join(root, "02-Profiles/lin/Memory.md"),
      `---
title: Lin Memory
type: memory
status: active
owner: lin
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

# Lin Memory
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
    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    services.db?.sqlite
      .prepare(
        `INSERT INTO review_items (
          id, workspace_id, state, risk, proposal_type, payload_json, reason,
          source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("review-memory-lin", services.workspaceId, "proposed", "high", "propose_memory", "{\"body\":\"Lin prefers visual structure.\"}", "reason", services.sessionId, "turn-1", new Date().toISOString());

    await expect(handleIpcRequest(services, "review:approve", { id: "review-memory-lin" })).resolves.toEqual(
      { ok: true, data: { id: "review-memory-lin", state: "applied" } },
    );

    await expect(readFile(path.join(root, "02-Profiles/lin/Memory.md"), "utf8")).resolves.toContain(
      "- Lin prefers visual structure.",
    );
  });

  it("returns the active profile and memory through get_profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "02-Profiles/lin"), { recursive: true });
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await mkdir(path.join(root, ".app"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
    await writeFile(path.join(root, ".app/settings.json"), JSON.stringify({ activeProfileId: "lin" }), "utf8");
    await writeFile(
      path.join(root, "02-Profiles/lin/Profile.md"),
      `---
title: Lin Profile
type: profile
status: active
owner: lin
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

# Lin Profile

Product builder.
`,
      "utf8",
    );
    await writeFile(
      path.join(root, "02-Profiles/lin/Memory.md"),
      `---
title: Lin Memory
type: memory
status: active
owner: lin
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

# Lin Memory

- Prefers auditable memory.
`,
      "utf8",
    );
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");
    const provider = new CaptureToolResultProvider("get_profile", "{}");
    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
      modelProvider: provider,
    };
    opened.push(services);
    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    await expect(
      handleIpcRequest(services, "chat:run-turn", { sessionId: services.sessionId, message: "load my profile" }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(provider.secondRequestContent()).toContain("Product builder.");
    expect(provider.secondRequestContent()).toContain("Prefers auditable memory.");
  });

  it("applies approved create-note proposals to the requested note path", async () => {
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

    const body = `---
title: Agent Contract
type: knowledge
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-26
tags: []
---

# Agent Contract

Review can create notes.
`;
    services.db?.sqlite
      .prepare(
        `INSERT INTO review_items (
          id, workspace_id, state, risk, proposal_type, payload_json, reason,
          target_path, source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("review-create-note", services.workspaceId, "proposed", "medium", "propose_create_note", JSON.stringify({ path: "03-Knowledge/Agent Contract.md", body }), "reason", "03-Knowledge/Agent Contract.md", services.sessionId, "turn-1", new Date().toISOString());

    await expect(handleIpcRequest(services, "review:approve", { id: "review-create-note" })).resolves.toEqual(
      { ok: true, data: { id: "review-create-note", state: "applied" } },
    );
    await expect(readFile(path.join(root, "03-Knowledge/Agent Contract.md"), "utf8")).resolves.toContain(
      "Review can create notes.",
    );
  });

  it("applies user routing overrides and records durable routing rules during review", async () => {
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

    const body = `---
title: Utility Bills
type: resource
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-26
tags: []
---

# Utility Bills

January bill.
`;
    services.db?.sqlite
      .prepare(
        `INSERT INTO review_items (
          id, workspace_id, state, risk, proposal_type, payload_json, reason,
          target_path, source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("review-routed-note", services.workspaceId, "proposed", "medium", "propose_create_note", JSON.stringify({ path: "04-Resources/Imports/Utility Bills.md", body }), "reason", "04-Resources/Imports/Utility Bills.md", services.sessionId, "turn-1", new Date().toISOString());

    await expect(
      handleIpcRequest(services, "review:approve", {
        id: "review-routed-note",
        targetPathOverride: "02-Personal/default/Finance/Utilities/2026/Utility Bills.md",
        categoryOverride: "finance.utility",
        saveAsRoutingRule: true,
        routingRulePattern: "utility bills",
      }),
    ).resolves.toEqual({ ok: true, data: { id: "review-routed-note", state: "applied" } });

    await expect(readFile(path.join(root, "02-Personal/default/Finance/Utilities/2026/Utility Bills.md"), "utf8")).resolves.toContain(
      "January bill.",
    );
    await expect(readFile(path.join(root, ".vault/routing-policy.json"), "utf8")).resolves.toContain(
      "02-Personal/default/Finance/Utilities/2026",
    );
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).resolves.toContain(
      "utility bills -> 02-Personal/default/Finance/Utilities/2026/Utility Bills.md",
    );
    await expect(readFile(path.join(root, ".vault/decisions/routing-rule-review-routed-note.md"), "utf8")).resolves.toContain(
      "User-defined routing rule",
    );
    const policy = JSON.parse(await readFile(path.join(root, ".vault/routing-policy.json"), "utf8"));
    expect(policy.rules).toEqual([
      expect.objectContaining({
        pattern: "utility bills",
        category: "finance.utility",
        destination: "02-Personal/default/Finance/Utilities/2026/Utility Bills.md",
      }),
    ]);
    expect(policy.rules[0]).not.toHaveProperty("skipReview");
  });

  it("revalidates a reviewed import with current overrides and promotes the latest staged body once", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const editedBody = (await readFile(path.join(root, sourceNotePath), "utf8"))
      .replace("Electric bill January 2026.", "Electric bill corrected during Review.");
    await writeFile(path.join(root, sourceNotePath), editedBody, "utf8");
    const destination = "04-Resources/Approved/Utility Bill.md";

    await expect(
      handleIpcRequest(services, "review:approve", {
        id: "review-import-source-note",
        targetPathOverride: destination,
        categoryOverride: "resource",
      }),
    ).resolves.toEqual({ ok: true, data: { id: "review-import-source-note", state: "applied" } });

    const promotedBody = await readFile(path.join(root, destination), "utf8");
    const promotedNote = await parseMarkdownNote(path.join(root, destination));
    expect(promotedBody).toContain("## Document\n\nElectric bill corrected during Review.");
    expect(promotedBody).not.toContain("Electric bill January 2026.");
    expect(promotedNote.frontmatter.content_category).toBe("resource");
    expect(promotedNote.frontmatter.classification_evidence).toEqual(
      expect.arrayContaining(["Amount: $123.45", "Due: 2026-01-15"]),
    );
    expect(promotedBody).toContain("route_status: approved");
    expect(promotedBody).toContain(`route_destination: ${destination}`);
    expect(promotedBody).toContain("source_file: ../../06-Attachments/Imports/Utility Bill/Utility Bill.pdf");
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).rejects.toThrow();

    await expect(
      handleIpcRequest(services, "review:approve", {
        id: "review-import-source-note",
        targetPathOverride: "04-Resources/Approved/Do Not Write.md",
        categoryOverride: "project.document",
      }),
    ).resolves.toEqual({ ok: true, data: { id: "review-import-source-note", state: "applied" } });
    await expect(readFile(path.join(root, destination), "utf8")).resolves.toBe(promotedBody);
    await expect(readFile(path.join(root, "04-Resources/Approved/Do Not Write.md"), "utf8")).rejects.toThrow();
  });

  it("atomically claims a Review item before concurrent approvals touch staging", async () => {
    const setup = await setupImportedReview();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    let reads = 0;
    setup.services.reviewApplyHooks = {
      afterClaim: async () => {
        readStarted.resolve();
        await releaseRead.promise;
      },
    };
    setup.services.reviewIoHooks = {
      afterPathSnapshot: async (operation) => {
        if (operation === "staging_read") {
        reads += 1;
        }
      },
    };
    const request = {
      id: "review-import-source-note",
      targetPathOverride: "04-Resources/Approved/Utility Bill.md",
      categoryOverride: "resource",
    };

    const firstApproval = handleIpcRequest(setup.services, "review:approve", request);
    await readStarted.promise;
    await expect(handleIpcRequest(setup.services, "review:approve", request)).resolves.toEqual({
      ok: false,
      error: "Review item is currently applying",
    });
    releaseRead.resolve();
    await expect(firstApproval).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
    expect(reads).toBe(1);
  });

  it("prevents rejection after approval has atomically claimed the proposal", async () => {
    const setup = await setupImportedReview();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    setup.services.reviewApplyHooks = {
      afterClaim: async () => {
        readStarted.resolve();
        await releaseRead.promise;
      },
    };

    const firstApproval = handleIpcRequest(setup.services, "review:approve", {
      id: "review-import-source-note",
      targetPathOverride: "04-Resources/Approved/Utility Bill.md",
      categoryOverride: "resource",
    });
    await readStarted.promise;
    await expect(handleIpcRequest(setup.services, "review:reject", { id: "review-import-source-note" })).resolves.toEqual({
      ok: false,
      error: "Review item is currently applying",
    });
    releaseRead.resolve();
    await expect(firstApproval).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
  });

  it("prevents an expired approval worker from completing a new owner's claim", async () => {
    const setup = await setupImportedReview();
    const firstReached = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondReached = deferred<void>();
    const releaseSecond = deferred<void>();
    let calls = 0;
    setup.services.reviewApplyHooks = {
      beforeApplied: async () => {
        calls += 1;
        if (calls === 1) {
          firstReached.resolve();
          await releaseFirst.promise;
        } else {
          secondReached.resolve();
          await releaseSecond.promise;
        }
      },
    };
    const request = {
      id: "review-import-source-note",
      targetPathOverride: "04-Resources/Approved/Utility Bill.md",
      categoryOverride: "resource" as const,
    };

    const first = handleIpcRequest(setup.services, "review:approve", request);
    await firstReached.promise;
    setup.services.db?.sqlite
      .prepare("UPDATE review_items SET claim_started_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "review-import-source-note");
    const second = handleIpcRequest(setup.services, "review:approve", request);
    await expect(Promise.race([
      secondReached.promise.then(() => "reached"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 200)),
    ])).resolves.toBe("reached");

    releaseFirst.resolve();
    await expect(first).resolves.toEqual({ ok: false, error: "Review claim was lost" });
    await expect(handleIpcRequest(setup.services, "review:list", {})).resolves.toEqual(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ id: "review-import-source-note", state: "applying" }),
        ]),
      }),
    );
    releaseSecond.resolve();
    await expect(second).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
  });

  it("keeps the applied destination when an old worker resumes before staging unlink", async () => {
    const setup = await setupImportedReview();
    const oldWorkerPaused = deferred<void>();
    const releaseOldWorker = deferred<void>();
    let unlinkSnapshots = 0;
    setup.services.reviewIoHooks = {
      afterPathSnapshot: async (operation) => {
        if (operation !== "staging_unlink") {
          return;
        }
        unlinkSnapshots += 1;
        if (unlinkSnapshots === 1) {
          oldWorkerPaused.resolve();
          await releaseOldWorker.promise;
        }
      },
    };
    const destination = "04-Resources/Approved/Utility Bill.md";
    const request = {
      id: "review-import-source-note",
      targetPathOverride: destination,
      categoryOverride: "resource" as const,
    };

    const oldWorker = handleIpcRequest(setup.services, "review:approve", request);
    await oldWorkerPaused.promise;
    setup.services.db?.sqlite
      .prepare("UPDATE review_items SET claim_started_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "review-import-source-note");
    await expect(handleIpcRequest(setup.services, "review:approve", request)).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
    const appliedBody = await readFile(path.join(setup.root, destination), "utf8");

    releaseOldWorker.resolve();
    await expect(oldWorker).resolves.toEqual({ ok: false, error: "Review claim was lost" });
    await expect(readFile(path.join(setup.root, destination), "utf8")).resolves.toBe(appliedBody);
    await expect(handleIpcRequest(setup.services, "review:list", {})).resolves.toEqual(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ id: "review-import-source-note", state: "applied" }),
        ]),
      }),
    );
  });

  it("does not roll back a replacement destination inode", async () => {
    const setup = await setupImportedReview();
    const destination = "04-Resources/Approved/Utility Bill.md";
    const destinationPath = path.join(setup.root, destination);
    const replacement = "replacement destination owned by another worker";
    setup.services.reviewImportFileOps = {
      unlink: async (targetPath) => {
        if (targetPath === path.join(setup.root, setup.sourceNotePath)) {
          await unlink(destinationPath);
          await writeFile(destinationPath, replacement, "utf8");
          throw new Error("staging unlink failed after replacement");
        }
        await unlink(targetPath);
      },
    };

    await expect(handleIpcRequest(setup.services, "review:approve", {
      id: "review-import-source-note",
      targetPathOverride: destination,
      categoryOverride: "resource",
    })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Destination identity changed before rollback"),
    });
    await expect(readFile(destinationPath, "utf8")).resolves.toBe(replacement);
    await expect(readFile(path.join(setup.root, setup.sourceNotePath), "utf8")).resolves.toContain("pending_review");
  });

  it("blocks a reviewed import collision during approval and preserves the staged authority", async () => {
    const existingDestination = activeResourceNote("Existing Utility Bill");
    const { root, services, sourceNotePath, destination } = await setupImportedReview({ existingDestination });

    await expect(handleIpcRequest(services, "review:approve", { id: "review-import-source-note" })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("DESTINATION_EXISTS"),
    });
    await expect(handleIpcRequest(services, "review:list", {})).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            id: "review-import-source-note",
            state: "failed",
            failureReason: expect.stringContaining("DESTINATION_EXISTS"),
          }),
        ]),
      }),
    );
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).resolves.toContain("Electric bill January 2026.");
    await expect(readFile(path.join(root, destination), "utf8")).resolves.toBe(existingDestination);
  });

  it("retries a failed approval from preserved staging with a corrected destination", async () => {
    const existingDestination = activeResourceNote("Existing Utility Bill");
    const { root, services, sourceNotePath } = await setupImportedReview({ existingDestination });

    await expect(handleIpcRequest(services, "review:approve", { id: "review-import-source-note" })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("DESTINATION_EXISTS"),
    });
    const correctedDestination = "04-Resources/Approved/Corrected Utility Bill.md";
    await expect(handleIpcRequest(services, "review:approve", {
      id: "review-import-source-note",
      targetPathOverride: correctedDestination,
      categoryOverride: "resource",
    })).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
    await expect(readFile(path.join(root, correctedDestination), "utf8")).resolves.toContain("Electric bill January 2026.");
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).rejects.toThrow();
  });

  it("reconciles a crash after promotion without rewriting the destination", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const destination = "04-Resources/Approved/Utility Bill.md";
    let interrupt = true;
    services.reviewApplyHooks = {
      afterPromotion: async () => {
        if (interrupt) {
          interrupt = false;
          throw new Error("simulated interruption after promotion");
        }
      },
    };
    const request = {
      id: "review-import-source-note",
      targetPathOverride: destination,
      categoryOverride: "resource" as const,
    };

    await expect(handleIpcRequest(services, "review:approve", request)).resolves.toEqual({
      ok: false,
      error: "simulated interruption after promotion",
    });
    const promotedBody = await readFile(path.join(root, destination), "utf8");
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).rejects.toThrow();
    services.db?.sqlite
      .prepare(
        "UPDATE review_items SET state = 'applying', claim_token = ?, claim_started_at = ? WHERE id = ?",
      )
      .run("interrupted-process", "2000-01-01T00:00:00.000Z", "review-import-source-note");
    services.reviewImportFileOps = {
      writeFile: async (targetPath, contents, exclusive) => {
        if (targetPath === path.join(root, destination)) {
          throw new Error("destination must not be rewritten");
        }
        await writeFile(targetPath, contents, { encoding: "utf8", flag: exclusive ? "wx" : "w" });
      },
    };

    await expect(handleIpcRequest(services, "review:approve", request)).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
    await expect(readFile(path.join(root, destination), "utf8")).resolves.toBe(promotedBody);
  });

  it("reconciles a crash window with both staging and an exact destination", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const destination = "04-Resources/Approved/Utility Bill.md";
    services.reviewImportFileOps = {
      unlink: async () => {
        throw new Error("simulated process stop before staging unlink");
      },
    };
    const request = {
      id: "review-import-source-note",
      targetPathOverride: destination,
      categoryOverride: "resource" as const,
    };

    await expect(handleIpcRequest(services, "review:approve", request)).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("destination rollback failed"),
    });
    const promoted = await readFile(path.join(root, destination), "utf8");
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).resolves.toContain("pending_review");
    services.reviewImportFileOps = undefined;

    await expect(handleIpcRequest(services, "review:approve", request)).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
    await expect(readFile(path.join(root, destination), "utf8")).resolves.toBe(promoted);
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).rejects.toThrow();
  });

  it("preserves staging when both-files reconciliation finds a destination mismatch", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const destination = "04-Resources/Approved/Utility Bill.md";
    services.reviewImportFileOps = {
      unlink: async () => {
        throw new Error("simulated process stop before staging unlink");
      },
    };
    const request = {
      id: "review-import-source-note",
      targetPathOverride: destination,
      categoryOverride: "resource" as const,
    };
    await handleIpcRequest(services, "review:approve", request);
    await writeFile(path.join(root, destination), "changed destination", "utf8");
    services.reviewImportFileOps = undefined;

    await expect(handleIpcRequest(services, "review:approve", request)).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("does not match"),
    });
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).resolves.toContain("pending_review");
  });

  it.each([
    {
      name: "create note",
      id: "review-generic-create-retry",
      proposalType: "propose_create_note",
      targetPath: "04-Resources/Generic Retry.md",
      payload: {
        path: "04-Resources/Generic Retry.md",
        body: activeResourceNote("Generic Retry"),
      },
    },
    {
      name: "decision",
      id: "review-generic-decision-retry",
      proposalType: "propose_decision",
      targetPath: ".vault/decisions/generic-retry.md",
      payload: { body: "# Generic retry decision" },
    },
  ])("reconciles an exact generic $name write after downstream failure", async (testCase) => {
    const { root, services } = await setupImportedReview();
    services.db?.sqlite
      .prepare(
        `INSERT INTO review_items (
          id, workspace_id, state, risk, proposal_type, payload_json, reason,
          target_path, source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        testCase.id,
        services.workspaceId,
        "proposed",
        "high",
        testCase.proposalType,
        JSON.stringify(testCase.payload),
        "retry",
        testCase.targetPath,
        services.sessionId,
        "turn-retry",
        new Date().toISOString(),
      );
    let interrupt = true;
    services.reviewApplyHooks = {
      beforeApplied: async (id) => {
        if (id === testCase.id && interrupt) {
          interrupt = false;
          throw new Error("downstream failed");
        }
      },
    };

    await expect(handleIpcRequest(services, "review:approve", { id: testCase.id })).resolves.toEqual({
      ok: false,
      error: "downstream failed",
    });
    const written = await readFile(path.join(root, testCase.targetPath), "utf8");
    await expect(handleIpcRequest(services, "review:approve", { id: testCase.id })).resolves.toEqual({
      ok: true,
      data: { id: testCase.id, state: "applied" },
    });
    await expect(readFile(path.join(root, testCase.targetPath), "utf8")).resolves.toBe(written);
  });

  it("rejects a generic retry when the existing destination changed after its write", async () => {
    const { root, services } = await setupImportedReview();
    const id = "review-generic-mismatch";
    const targetPath = "04-Resources/Generic Mismatch.md";
    services.db?.sqlite
      .prepare(
        `INSERT INTO review_items (
          id, workspace_id, state, risk, proposal_type, payload_json, reason,
          target_path, source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        services.workspaceId,
        "proposed",
        "high",
        "propose_create_note",
        JSON.stringify({ path: targetPath, body: activeResourceNote("Generic Mismatch") }),
        "retry",
        targetPath,
        services.sessionId,
        "turn-retry",
        new Date().toISOString(),
      );
    let interrupt = true;
    services.reviewApplyHooks = {
      beforeApplied: async (reviewId) => {
        if (reviewId === id && interrupt) {
          interrupt = false;
          throw new Error("downstream failed");
        }
      },
    };
    await handleIpcRequest(services, "review:approve", { id });
    await writeFile(path.join(root, targetPath), activeResourceNote("Changed"), "utf8");

    await expect(handleIpcRequest(services, "review:approve", { id })).resolves.toEqual({
      ok: false,
      error: "Existing destination does not match the persisted application",
    });
  });

  it("finishes post-move work before applied and replays it without duplicates", async () => {
    const { root, services } = await setupImportedReview();
    const destination = "04-Resources/Approved/Utility Bill.md";
    let interrupt = true;
    services.reviewApplyHooks = {
      beforeApplied: async () => {
        if (interrupt) {
          interrupt = false;
          throw new Error("simulated interruption before applied");
        }
      },
    };
    const request = {
      id: "review-import-source-note",
      targetPathOverride: destination,
      categoryOverride: "resource" as const,
      saveAsRoutingRule: true,
      routingRulePattern: "utility bill",
    };

    await expect(handleIpcRequest(services, "review:approve", request)).resolves.toEqual({
      ok: false,
      error: "simulated interruption before applied",
    });
    await expect(handleIpcRequest(services, "review:list", {})).resolves.toEqual(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ id: "review-import-source-note", state: "failed" }),
        ]),
      }),
    );

    await expect(handleIpcRequest(services, "review:approve", request)).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
    const policy = JSON.parse(await readFile(path.join(root, ".vault/routing-policy.json"), "utf8")) as {
      rules: Array<{ id: string }>;
    };
    expect(policy.rules.filter((rule) => rule.id === "routing-rule-review-import-source-note")).toHaveLength(1);
    expect(
      services.db?.sqlite
        .prepare("SELECT COUNT(*) AS count FROM activity_events WHERE id = ?")
        .get("review-applied-review-import-source-note"),
    ).toEqual({ count: 1 });
  });

  it("keeps workspace escapes blocked after approval and preserves staging", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();

    await expect(
      handleIpcRequest(services, "review:approve", {
        id: "review-import-source-note",
        targetPathOverride: "../outside.md",
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("PATH_ESCAPES_WORKSPACE"),
    });
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).resolves.toContain("route_status: pending_review");
    await expect(readFile(path.resolve(root, "../outside.md"), "utf8")).rejects.toThrow();
  });

  it("rejects a staged note symlink whose real path escapes the workspace", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const outside = path.join(await mkdtemp(path.join(tmpdir(), "kb-agent-outside-")), "Staged.md");
    const stagedBody = await readFile(path.join(root, sourceNotePath), "utf8");
    await writeFile(outside, stagedBody, "utf8");
    await unlink(path.join(root, sourceNotePath));
    await symlink(outside, path.join(root, sourceNotePath));

    await expect(handleIpcRequest(services, "review:approve", { id: "review-import-source-note" })).resolves.toEqual({
      ok: false,
      error: "Path resolves outside workspace",
    });
    await expect(readFile(outside, "utf8")).resolves.toBe(stagedBody);
  });

  it("rejects a destination whose nearest existing parent symlink escapes the workspace", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-outside-"));
    await mkdir(path.join(root, "04-Resources"), { recursive: true });
    await symlink(outside, path.join(root, "04-Resources/Approved"), "dir");

    await expect(handleIpcRequest(services, "review:approve", {
      id: "review-import-source-note",
      targetPathOverride: "04-Resources/Approved/Utility Bill.md",
      categoryOverride: "resource",
    })).resolves.toEqual({
      ok: false,
      error: "Path resolves outside workspace",
    });
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).resolves.toContain("route_status: pending_review");
    await expect(readFile(path.join(outside, "Utility Bill.md"), "utf8")).rejects.toThrow();
  });

  it("detects a destination parent replacement after validation without writing outside", async () => {
    const { root, services } = await setupImportedReview();
    const destination = "04-Resources/Approved/Utility Bill.md";
    const parent = path.join(root, "04-Resources/Approved");
    const movedParent = path.join(root, "04-Resources/Approved.original");
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-outside-"));
    await mkdir(parent, { recursive: true });
    (services as IpcServices & {
      reviewIoHooks: { afterPathSnapshot(operation: string): Promise<void> };
    }).reviewIoHooks = {
      afterPathSnapshot: async (operation) => {
        if (operation === "destination_create") {
          await rename(parent, movedParent);
          await symlink(outside, parent, "dir");
        }
      },
    };

    await expect(handleIpcRequest(services, "review:approve", {
      id: "review-import-source-note",
      targetPathOverride: destination,
      categoryOverride: "resource",
    })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Path"),
    });
    await expect(readFile(path.join(outside, "Utility Bill.md"), "utf8")).rejects.toThrow();
  });

  it("detects a staging parent replacement immediately before read", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const parent = path.dirname(path.join(root, sourceNotePath));
    const movedParent = `${parent}.original`;
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-outside-"));
    const outsideNote = path.join(outside, path.basename(sourceNotePath));
    await writeFile(outsideNote, await readFile(path.join(root, sourceNotePath), "utf8"), "utf8");
    (services as IpcServices & {
      reviewIoHooks: { afterPathSnapshot(operation: string): Promise<void> };
    }).reviewIoHooks = {
      afterPathSnapshot: async (operation) => {
        if (operation === "staging_read") {
          await rename(parent, movedParent);
          await symlink(outside, parent, "dir");
        }
      },
    };

    await expect(handleIpcRequest(services, "review:approve", {
      id: "review-import-source-note",
    })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Path"),
    });
    await expect(readFile(outsideNote, "utf8")).resolves.toContain("pending_review");
  });

  it("detects a staging parent replacement immediately before unlink and rolls back promotion", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const parent = path.dirname(path.join(root, sourceNotePath));
    const movedParent = `${parent}.original`;
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-outside-"));
    const outsideNote = path.join(outside, path.basename(sourceNotePath));
    await writeFile(outsideNote, await readFile(path.join(root, sourceNotePath), "utf8"), "utf8");
    (services as IpcServices & {
      reviewIoHooks: { afterPathSnapshot(operation: string): Promise<void> };
    }).reviewIoHooks = {
      afterPathSnapshot: async (operation) => {
        if (operation === "staging_unlink") {
          await rename(parent, movedParent);
          await symlink(outside, parent, "dir");
        }
      },
    };
    const destination = "04-Resources/Approved/Utility Bill.md";

    await expect(handleIpcRequest(services, "review:approve", {
      id: "review-import-source-note",
      targetPathOverride: destination,
      categoryOverride: "resource",
    })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Path"),
    });
    await expect(readFile(path.join(root, destination), "utf8")).rejects.toThrow();
    await expect(readFile(outsideNote, "utf8")).resolves.toContain("pending_review");
  });

  it("detects a staging parent replacement immediately before rejection rewrite", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const parent = path.dirname(path.join(root, sourceNotePath));
    const movedParent = `${parent}.original`;
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-outside-"));
    const outsideNote = path.join(outside, path.basename(sourceNotePath));
    const original = await readFile(path.join(root, sourceNotePath), "utf8");
    await writeFile(outsideNote, original, "utf8");
    (services as IpcServices & {
      reviewIoHooks: { afterPathSnapshot(operation: string): Promise<void> };
    }).reviewIoHooks = {
      afterPathSnapshot: async (operation) => {
        if (operation === "staging_rewrite") {
          await rename(parent, movedParent);
          await symlink(outside, parent, "dir");
        }
      },
    };

    await expect(handleIpcRequest(services, "review:reject", {
      id: "review-import-source-note",
    })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("Path"),
    });
    await expect(readFile(outsideNote, "utf8")).resolves.toBe(original);
  });

  it("migrates a legacy Task 3 imported-source payload from staged frontmatter", async () => {
    const { root, services, sourceNotePath, destination } = await setupImportedReview();
    services.db?.sqlite
      .prepare("UPDATE review_items SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ sourceNotePath, destination }), "review-import-source-note");

    await expect(handleIpcRequest(services, "review:approve", {
      id: "review-import-source-note",
      targetPathOverride: "04-Resources/Approved/Legacy Utility Bill.md",
      categoryOverride: "resource",
    })).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
    await expect(readFile(path.join(root, "04-Resources/Approved/Legacy Utility Bill.md"), "utf8")).resolves.toContain(
      "Electric bill January 2026.",
    );
  });

  it("derives a saved rule category from the reconstructed legacy payload", async () => {
    const { root, services, sourceNotePath, destination } = await setupImportedReview();
    services.db?.sqlite
      .prepare("UPDATE review_items SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ sourceNotePath, destination }), "review-import-source-note");

    await expect(handleIpcRequest(services, "review:approve", {
      id: "review-import-source-note",
      saveAsRoutingRule: true,
      routingRulePattern: "legacy utility",
    })).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });
    const policy = JSON.parse(await readFile(path.join(root, ".vault/routing-policy.json"), "utf8")) as {
      rules: Array<{ category?: string }>;
    };
    expect(policy.rules[0]?.category).toBe("finance.utility");
  });

  it("round-trips YAML-sensitive route and source filenames during approval", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    const stagedPath = path.join(root, sourceNotePath);
    const sourceFile = "../../../06-Attachments/Imports/Bill #1: July.pdf";
    const staged = (await readFile(stagedPath, "utf8"))
      .replace(/^source_file: .+$/mu, `source_file: ${JSON.stringify(sourceFile)}`)
      .replace(/(- \[Original file\]\()[^)]+(\))/u, `$1${sourceFile}$2`);
    await writeFile(stagedPath, staged, "utf8");
    const destination = "04-Resources/Approved/Bill #1: July.md";

    await expect(handleIpcRequest(services, "review:approve", {
      id: "review-import-source-note",
      targetPathOverride: destination,
      categoryOverride: "resource",
    })).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "applied" },
    });

    const promoted = await parseMarkdownNote(path.join(root, destination));
    expect(promoted.frontmatter.route_destination).toBe(destination);
    expect(promoted.frontmatter.source_file).toBe("../../06-Attachments/Imports/Bill #1: July.pdf");
    expect(promoted.frontmatter.content_category).toBe("resource");
    expect(promoted.frontmatter.status).toBe("approved");
  });

  it("does not approve a Review item whose safety decision is blocked", async () => {
    const { root, services, sourceNotePath, destination } = await setupImportedReview({
      safetyDecision: {
        decision: "blocked",
        reasonCodes: ["DESTINATION_EXISTS"],
      },
    });

    await expect(handleIpcRequest(services, "review:approve", { id: "review-import-source-note" })).resolves.toEqual({
      ok: false,
      error: "Blocked import artifacts cannot be approved",
    });
    await expect(handleIpcRequest(services, "review:list", {})).resolves.toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ id: "review-import-source-note", state: "proposed" })],
      }),
    );
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).resolves.toContain("route_status: pending_review");
    await expect(readFile(path.join(root, destination), "utf8")).rejects.toThrow();
  });

  it("re-reads the staged route state immediately before approval", async () => {
    const { root, services, sourceNotePath, destination } = await setupImportedReview();
    const blockedBody = (await readFile(path.join(root, sourceNotePath), "utf8"))
      .replace("status: pending_review", "status: blocked")
      .replace("route_status: pending_review", "route_status: blocked");
    await writeFile(path.join(root, sourceNotePath), blockedBody, "utf8");

    await expect(handleIpcRequest(services, "review:approve", { id: "review-import-source-note" })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("no longer pending review"),
    });
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).resolves.toContain("route_status: blocked");
    await expect(readFile(path.join(root, destination), "utf8")).rejects.toThrow();
  });

  it("rolls back a promoted destination when removing staging fails", async () => {
    const setup = await setupImportedReview();
    setup.services.reviewImportFileOps = {
      unlink: async (targetPath) => {
        if (targetPath === path.join(setup.root, setup.sourceNotePath)) {
          throw new Error("staging unlink failed");
        }
        await unlink(targetPath);
      },
    };

    await expect(
      handleIpcRequest(setup.services, "review:approve", {
        id: "review-import-source-note",
        targetPathOverride: "04-Resources/Approved/Utility Bill.md",
        categoryOverride: "resource",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "staging unlink failed",
    });
    await expect(readFile(path.join(setup.root, setup.sourceNotePath), "utf8")).resolves.toContain("route_status: pending_review");
    await expect(readFile(path.join(setup.root, "04-Resources/Approved/Utility Bill.md"), "utf8")).rejects.toThrow();
  });

  it("stamps a rejected import in staging without deleting it", async () => {
    const { root, services, sourceNotePath, destination } = await setupImportedReview();

    await expect(handleIpcRequest(services, "review:reject", { id: "review-import-source-note" })).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "rejected" },
    });
    const rejectedBody = await readFile(path.join(root, sourceNotePath), "utf8");
    const rejectedNote = await parseMarkdownNote(path.join(root, sourceNotePath));
    expect(rejectedBody).toContain("status: rejected");
    expect(rejectedNote.frontmatter.tags).toEqual(["imported", "rejected"]);
    expect(rejectedBody).toContain("route_status: rejected");
    expect(rejectedBody).toContain("- Status: rejected");
    expect(rejectedBody).toContain("Electric bill January 2026.");
    await expect(readFile(path.join(root, destination), "utf8")).rejects.toThrow();
  });

  it("takes over an expired rejecting lease and completes rejection", async () => {
    const { root, services, sourceNotePath } = await setupImportedReview();
    services.db?.sqlite
      .prepare(
        "UPDATE review_items SET state = 'rejecting', claim_token = ?, claim_started_at = ? WHERE id = ?",
      )
      .run("stopped-rejecter", "2000-01-01T00:00:00.000Z", "review-import-source-note");

    await expect(handleIpcRequest(services, "review:reject", { id: "review-import-source-note" })).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "rejected" },
    });
    const rejected = await parseMarkdownNote(path.join(root, sourceNotePath));
    expect(rejected.frontmatter.status).toBe("rejected");
  });

  it("prevents an old rejecter from overwriting body B after takeover", async () => {
    const setup = await setupImportedReview();
    const oldWorkerPaused = deferred<void>();
    const releaseOldWorker = deferred<void>();
    let rewriteSnapshots = 0;
    setup.services.reviewIoHooks = {
      afterPathSnapshot: async (operation) => {
        if (operation !== "staging_rewrite") {
          return;
        }
        rewriteSnapshots += 1;
        if (rewriteSnapshots === 1) {
          oldWorkerPaused.resolve();
          await releaseOldWorker.promise;
        }
      },
    };

    const oldWorker = handleIpcRequest(setup.services, "review:reject", {
      id: "review-import-source-note",
    });
    await oldWorkerPaused.promise;
    setup.services.db?.sqlite
      .prepare("UPDATE review_items SET claim_started_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "review-import-source-note");
    const stagedPath = path.join(setup.root, setup.sourceNotePath);
    const bodyB = (await readFile(stagedPath, "utf8"))
      .replace("Electric bill January 2026.", "Body B from the takeover.");
    await writeFile(stagedPath, bodyB, "utf8");

    await expect(handleIpcRequest(setup.services, "review:reject", {
      id: "review-import-source-note",
    })).resolves.toEqual({
      ok: true,
      data: { id: "review-import-source-note", state: "rejected" },
    });
    releaseOldWorker.resolve();
    await expect(oldWorker).resolves.toEqual({ ok: false, error: "Review claim was lost" });
    const finalBody = await readFile(stagedPath, "utf8");
    expect(finalBody).toContain("Body B from the takeover.");
    expect(finalBody).not.toContain("Electric bill January 2026.");
  });

  it("applies approved decision proposals to the workspace decision folder", async () => {
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

    services.db?.sqlite
      .prepare(
        `INSERT INTO review_items (
          id, workspace_id, state, risk, proposal_type, payload_json, reason,
          source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("review-decision-1", services.workspaceId, "proposed", "high", "propose_decision", JSON.stringify({ body: "# Decision\n\nUse report-only workspace audit first." }), "reason", services.sessionId, "turn-1", new Date().toISOString());

    await expect(handleIpcRequest(services, "review:approve", { id: "review-decision-1" })).resolves.toEqual(
      { ok: true, data: { id: "review-decision-1", state: "applied" } },
    );
    await expect(readFile(path.join(root, ".vault/decisions/review-decision-1.md"), "utf8")).resolves.toContain(
      "Use report-only workspace audit first.",
    );
  });

  it("runs a report-only workspace audit through IPC", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nOutdated contract.", "utf8");
    await writeFile(path.join(root, "03-Knowledge/Broken.md"), "# Broken\n\nMissing frontmatter.", "utf8");
    const services: IpcServices = {
      activeTurns: new Set(),
      abortControllers: new Map(),
      settingsPath: path.join(root, ".app/settings.json"),
    };
    opened.push(services);
    await handleIpcRequest(services, "workspace:open", { rootPath: root });

    await expect(handleIpcRequest(services, "workspace:audit", {})).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          status: "fail",
          findings: expect.arrayContaining([
            expect.objectContaining({ code: "missing_frontmatter", path: "03-Knowledge/Broken.md" }),
          ]),
        }),
      }),
    );
  });

  it("imports local documents into staged source notes that require Review", async () => {
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
          notes: [
            expect.objectContaining({
              status: "pending_review",
              notePath: expect.stringMatching(/^\.app\/import-staging\//u),
            }),
            expect.objectContaining({
              status: "pending_review",
              notePath: expect.stringMatching(/^\.app\/import-staging\//u),
            }),
          ],
        }),
      }),
    );

    await expect(handleIpcRequest(services, "review:list", {})).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        data: [
          expect.objectContaining({ state: "proposed" }),
          expect.objectContaining({ state: "proposed" }),
        ],
      }),
    );
  });
});

async function setupImportedReview(input: {
  existingDestination?: string;
  safetyDecision?: {
    decision: "review_required" | "blocked";
    reasonCodes: string[];
  };
} = {}): Promise<{
  root: string;
  services: IpcServices;
  sourceNotePath: string;
  destination: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
  const sourceNotePath = ".app/import-staging/import-1/Utility Bill.md";
  const destination = "02-Personal/default/Finance/Utilities/2026/Utility Bill.md";
  const attachmentPath = "06-Attachments/Imports/Utility Bill/Utility Bill.pdf";
  const classification = financeImportClassification();
  const safetyDecision = input.safetyDecision ?? reviewRequiredSafetyDecision();
  await mkdir(path.dirname(path.join(root, sourceNotePath)), { recursive: true });
  await mkdir(path.dirname(path.join(root, attachmentPath)), { recursive: true });
  await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nUse local notes.", "utf8");
  await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");
  await writeFile(path.join(root, attachmentPath), "original attachment", "utf8");
  await writeFile(
    path.join(root, sourceNotePath),
    importedSourceBody({
      destination,
      sourceLink: "../../../06-Attachments/Imports/Utility Bill/Utility Bill.pdf",
    }),
    "utf8",
  );
  if (input.existingDestination !== undefined) {
    await mkdir(path.dirname(path.join(root, destination)), { recursive: true });
    await writeFile(path.join(root, destination), input.existingDestination, "utf8");
  }

  const services: IpcServices = {
    activeTurns: new Set(),
    abortControllers: new Map(),
    settingsPath: path.join(root, ".app/settings.json"),
  };
  opened.push(services);
  await expect(handleIpcRequest(services, "workspace:open", { rootPath: root })).resolves.toEqual(
    expect.objectContaining({ ok: true }),
  );
  services.db?.sqlite
    .prepare(
      `INSERT INTO review_items (
        id, workspace_id, state, risk, proposal_type, payload_json, reason,
        target_path, source_session_id, source_turn_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "review-import-source-note",
      services.workspaceId,
      "proposed",
      "high",
      "propose_create_note",
      JSON.stringify({
        sourceNotePath,
        destination,
        classification,
        safetyDecision,
        sourceFile: "Utility Bill.pdf",
      }),
      "Utility bill needs review.",
      destination,
      services.sessionId,
      "turn-1",
      new Date().toISOString(),
    );

  return { root, services, sourceNotePath, destination };
}

function financeImportClassification() {
  return {
    primaryCategory: "finance.utility",
    alternativeCategories: [],
    sensitivity: "personal",
    confidence: 0.8,
    evidence: ["Amount: $123.45", "Due: 2026-01-15"],
    signals: [
      {
        source: "detector",
        category: "finance.utility",
        sensitivity: "personal",
        confidence: 0.8,
        evidence: ["Amount: $123.45", "Due: 2026-01-15"],
      },
    ],
    suggestedDestination: "02-Personal/default/Finance/Utilities/2026/Utility Bill.md",
    conflict: false,
  };
}

function reviewRequiredSafetyDecision() {
  return {
    decision: "review_required" as const,
    reasonCodes: [
      "CONFIDENCE_BELOW_THRESHOLD",
      "SENSITIVITY_REQUIRES_REVIEW",
      "CATEGORY_REQUIRES_REVIEW",
      "SAFETY_SIGNAL_REQUIRES_REVIEW",
      "DESTINATION_REQUIRES_REVIEW",
    ],
  };
}

function importedSourceBody(input: { destination: string; sourceLink: string }): string {
  return `---
title: Utility Bill
type: resource
status: pending_review
owner: default
scope: personal
sensitivity: normal
created: 2026-07-26
tags: [imported, pending-review]
source_type: import
source_file: ${input.sourceLink}
summary: Utility bill.
content_category: finance.utility
classification_confidence: 0.8
classification_evidence: ["Amount: $123.45","Due: 2026-01-15"]
review_decision: review_required
safety_reason_codes: ["CONFIDENCE_BELOW_THRESHOLD","SENSITIVITY_REQUIRES_REVIEW","CATEGORY_REQUIRES_REVIEW","SAFETY_SIGNAL_REQUIRES_REVIEW","DESTINATION_REQUIRES_REVIEW"]
route_status: pending_review
route_destination: ${input.destination}
---

# Utility Bill

## Document

Electric bill January 2026.

## Source

- [Original file](${input.sourceLink})

## Routing

- Status: pending_review
- Destination: ${input.destination}
`;
}

function activeResourceNote(title: string): string {
  return `---
title: ${title}
type: resource
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-26
tags: []
---

# ${title}
`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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

class CaptureToolResultProvider implements ModelProvider {
  readonly supportsToolCalling = true;
  readonly supportsPromptCache = false;
  private requests: ModelRequest[] = [];

  constructor(private readonly toolName: string, private readonly argumentsJson: string) {}

  async complete(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    if (this.requests.length === 1) {
      return {
        content: "",
        toolCalls: [{ id: "capture-call-1", name: this.toolName, argumentsJson: this.argumentsJson }],
      };
    }

    return { content: "Profile loaded." };
  }

  async *stream(input: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: "done", response: await this.complete(input) };
  }

  async estimateCost(): Promise<CostEstimate> {
    return { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  }

  secondRequestContent(): string {
    return JSON.stringify(this.requests[1]?.messages ?? []);
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
