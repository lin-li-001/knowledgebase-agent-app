import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createReviewItem, listActivity, listReviewItems, openAppDatabase, recordActivity, searchNotes, transitionReviewItem, type ActivityEvent, type AppDatabase, type ReviewItem } from "@kb-agent/storage";
import { MockProvider, OpenAIProvider, type ModelProvider } from "@kb-agent/model";
import { runTurn, type ToolHandler, type MvpToolName } from "@kb-agent/core";
import { assertInsideWorkspace, createWorkspace, indexWorkspace, workspaceIdForRoot } from "@kb-agent/workspace";
import { loadApiKey, readDesktopSettings, saveApiKey, writeDesktopSettings } from "./secureSettings";
import { isAllowedChannel, type IpcChannel, type IpcResult } from "./ipcContract";
export { allowedChannels, isAllowedChannel } from "./ipcContract";

export interface IpcServices {
  workspaceRoot?: string;
  workspaceId?: string;
  db?: AppDatabase;
  sessionId?: string;
  settingsPath?: string;
  activeTurns: Set<string>;
  abortControllers?: Map<string, AbortController>;
  modelProvider?: ModelProvider;
}

const schemas: Record<IpcChannel, z.ZodTypeAny> = {
  "workspace:create": z.object({ rootPath: z.string() }),
  "workspace:open": z.object({ rootPath: z.string() }),
  "workspace:get-active": z.object({}),
  "settings:get": z.object({}),
  "settings:update": z.object({ apiKey: z.string().optional(), modelName: z.string().optional() }),
  "chat:run-turn": z.object({ sessionId: z.string(), message: z.string() }),
  "notes:search": z.object({ query: z.string() }),
  "notes:read": z.object({ path: z.string() }),
  "review:list": z.object({}),
  "review:approve": z.object({ id: z.string() }),
  "review:reject": z.object({ id: z.string() }),
  "activity:list": z.object({}),
  "index:rebuild": z.object({}),
  "chat:cancel-turn": z.object({ sessionId: z.string() }),
};

export async function handleIpcRequest(
  services: IpcServices,
  channel: string,
  input: unknown,
): Promise<IpcResult> {
  try {
    if (!isAllowedChannel(channel)) {
      return { ok: false, error: "Unknown IPC channel" };
    }

    const payload = schemas[channel].parse(input) as Record<string, unknown>;

    switch (channel) {
      case "workspace:create": {
        const workspace = await createWorkspace(payload.rootPath as string);
        await activateWorkspace(services, workspace.rootPath);
        return { ok: true, data: { ...workspace, workspaceId: services.workspaceId, sessionId: services.sessionId } };
      }
      case "workspace:open": {
        await activateWorkspace(services, path.resolve(payload.rootPath as string));
        return { ok: true, data: { rootPath: services.workspaceRoot, workspaceId: services.workspaceId, sessionId: services.sessionId } };
      }
      case "workspace:get-active":
        return {
          ok: true,
          data: services.workspaceRoot ? { rootPath: services.workspaceRoot, workspaceId: services.workspaceId, sessionId: services.sessionId } : null,
        };
      case "settings:get": {
        const settings = await readDesktopSettings(requireSettingsPath(services));
        return { ok: true, data: { ...settings, hasApiKey: Boolean(await loadApiKey(requireSettingsPath(services))) } };
      }
      case "settings:update": {
        const settingsPath = requireSettingsPath(services);
        if (typeof payload.apiKey === "string" && payload.apiKey.trim()) {
          await saveApiKey(settingsPath, payload.apiKey.trim());
        }
        if (typeof payload.modelName === "string") {
          const settings = await readDesktopSettings(settingsPath);
          await writeDesktopSettings(settingsPath, { ...settings, modelName: payload.modelName.trim() || "mock" });
        }
        return handleIpcRequest(services, "settings:get", {});
      }
      case "chat:run-turn": {
        const root = requireWorkspaceRoot(services);
        const db = requireDatabase(services);
        const workspaceId = requireWorkspaceId(services);
        const sessionId = payload.sessionId as string;
        const controller = new AbortController();
        services.activeTurns.add(sessionId);
        services.abortControllers?.set(sessionId, controller);
        const events = [];
        try {
          for await (const event of runTurn({
            db,
            modelProvider: await getModelProvider(services),
            model: await getModelName(services),
            workspaceId,
            workspaceRoot: root,
            sessionId,
            userMessage: payload.message as string,
            handlers: createDefaultToolHandlers(services),
            signal: controller.signal,
          })) {
            events.push(event);
          }
        } finally {
          services.activeTurns.delete(sessionId);
          services.abortControllers?.delete(sessionId);
        }
        return { ok: true, data: { events } };
      }
      case "notes:search": {
        return { ok: true, data: await searchNotes(requireDatabase(services), payload.query as string, { workspaceId: requireWorkspaceId(services) }) };
      }
      case "notes:read": {
        const root = requireWorkspaceRoot(services);
        const targetPath = assertInsideWorkspace(root, payload.path as string);
        return { ok: true, data: { path: payload.path, content: await readFile(targetPath, "utf8") } };
      }
      case "review:list":
        return { ok: true, data: await listReviewItems(requireDatabase(services), requireWorkspaceId(services), "all") };
      case "review:approve":
        await transitionReviewItem(requireDatabase(services), payload.id as string, "proposed", "approved");
        return { ok: true, data: { id: payload.id, state: "approved" } };
      case "review:reject":
        await transitionReviewItem(requireDatabase(services), payload.id as string, "proposed", "rejected");
        return { ok: true, data: { id: payload.id, state: "rejected" } };
      case "activity:list":
        return { ok: true, data: await listActivity(requireDatabase(services), requireWorkspaceId(services), 50) };
      case "index:rebuild": {
        const result = await indexWorkspace(requireWorkspaceRoot(services), requireDatabase(services));
        await recordActivity(requireDatabase(services), {
          id: randomUUID(),
          workspaceId: result.workspaceId,
          kind: "index",
          title: "Index rebuilt",
          message: `${result.noteCount} notes indexed.`,
          createdAt: new Date().toISOString(),
        });
        return { ok: true, data: result };
      }
      case "chat:cancel-turn": {
        services.activeTurns.delete(payload.sessionId as string);
        services.abortControllers?.get(payload.sessionId as string)?.abort();
        services.abortControllers?.delete(payload.sessionId as string);
        return { ok: true, data: { interrupted: true } };
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function activateWorkspace(services: IpcServices, rootPath: string): Promise<void> {
  services.db?.close();
  services.workspaceRoot = path.resolve(rootPath);
  services.db = openAppDatabase(path.join(services.workspaceRoot, ".app/index.sqlite"));
  const result = await indexWorkspace(services.workspaceRoot, services.db);
  services.workspaceId = result.workspaceId;
  services.sessionId = ensureSession(services.db, result.workspaceId);
  await recordActivity(services.db, {
    id: randomUUID(),
    workspaceId: result.workspaceId,
    kind: "workspace",
    title: "Workspace active",
    message: `${result.noteCount} notes indexed.`,
    createdAt: new Date().toISOString(),
  });
}

function ensureSession(db: AppDatabase, workspaceId: string): string {
  const existing = db.sqlite
    .prepare("SELECT id FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1")
    .get(workspaceId) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  db.sqlite
    .prepare("INSERT INTO sessions (id, workspace_id, profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, workspaceId, "default", "Chat", now, now);
  return id;
}

function createDefaultToolHandlers(services: IpcServices): Map<MvpToolName, ToolHandler> {
  const handlers = new Map<MvpToolName, ToolHandler>();
  handlers.set("search_notes", async (args) => searchNotes(requireDatabase(services), String((args as { query?: string }).query ?? ""), { workspaceId: requireWorkspaceId(services) }));
  handlers.set("read_note", async (args) => {
    const notePath = assertInsideWorkspace(requireWorkspaceRoot(services), String((args as { path?: string }).path ?? ""));
    return { content: await readFile(notePath, "utf8") };
  });
  handlers.set("list_notes", async (args) => listNotes(requireDatabase(services), requireWorkspaceId(services), Number((args as { limit?: number }).limit ?? 20)));
  handlers.set("get_workspace_rules", async () => ({ content: await readFile(path.join(requireWorkspaceRoot(services), "AGENTS.md"), "utf8") }));
  handlers.set("get_profile", async () => ({ content: "default" }));

  for (const name of ["propose_create_note", "propose_update_note", "propose_memory", "propose_decision", "propose_delete"] as MvpToolName[]) {
    handlers.set(name, async (args) => createProposalReviewItem(services, name, args));
  }

  return handlers;
}

function listNotes(db: AppDatabase, workspaceId: string, limit: number): unknown[] {
  return db.sqlite
    .prepare(
      `SELECT id as noteId, workspace_id as workspaceId, path, title, summary
      FROM notes
      WHERE workspace_id = ?
      ORDER BY path ASC
      LIMIT ?`,
    )
    .all(workspaceId, limit);
}

async function createProposalReviewItem(services: IpcServices, proposalType: MvpToolName, payload: unknown): Promise<{ reviewItemId: string }> {
  const workspaceId = requireWorkspaceId(services);
  const db = requireDatabase(services);
  const now = new Date().toISOString();
  const id = randomUUID();
  const targetPath = typeof payload === "object" && payload && "path" in payload ? String((payload as { path?: string }).path ?? "") : undefined;
  const reviewItem: ReviewItem = {
    id,
    workspaceId,
    state: "proposed",
    risk: proposalType === "propose_delete" ? "explicit" : proposalType.includes("memory") || proposalType.includes("decision") ? "high" : "medium",
    proposalType,
    payload,
    reason: "Model proposed a knowledge-base change.",
    sourceSessionId: services.sessionId ?? "unknown",
    sourceTurnId: randomUUID(),
    createdAt: now,
  };
  if (targetPath) {
    reviewItem.targetPath = targetPath;
  }
  await createReviewItem(db, reviewItem);

  const activity: ActivityEvent = {
    id: randomUUID(),
    workspaceId,
    kind: "review",
    title: "Review item created",
    message: `${proposalType} requires review.`,
    reviewItemId: id,
    createdAt: now,
  };
  if (targetPath) {
    activity.entityPath = targetPath;
  }
  await recordActivity(db, activity);
  return { reviewItemId: id };
}

async function getModelProvider(services: IpcServices): Promise<ModelProvider> {
  if (services.modelProvider) {
    return services.modelProvider;
  }

  const apiKey = services.settingsPath ? await loadApiKey(services.settingsPath) : null;
  if (apiKey) {
    return new OpenAIProvider({ apiKey });
  }

  return new MockProvider([{ role: "assistant", content: "Mock response complete." }]);
}

async function getModelName(services: IpcServices): Promise<string> {
  const settings = services.settingsPath ? await readDesktopSettings(services.settingsPath) : {};
  return settings.modelName ?? "mock";
}

function requireWorkspaceRoot(services: IpcServices): string {
  if (!services.workspaceRoot) {
    throw new Error("No active workspace");
  }

  return services.workspaceRoot;
}

function requireWorkspaceId(services: IpcServices): string {
  if (!services.workspaceId) {
    if (services.workspaceRoot) {
      return workspaceIdForRoot(services.workspaceRoot);
    }
    throw new Error("No active workspace");
  }

  return services.workspaceId;
}

function requireDatabase(services: IpcServices): AppDatabase {
  if (!services.db) {
    throw new Error("No active workspace");
  }

  return services.db;
}

function requireSettingsPath(services: IpcServices): string {
  if (!services.settingsPath) {
    throw new Error("No settings path configured");
  }

  return services.settingsPath;
}
