import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createReviewItem, getReviewItem, getReviewItemState, listActivity, listReviewItems, openAppDatabase, recordActivity, searchNotes, searchSessions, transitionReviewItem, type ActivityEvent, type AppDatabase, type ReviewItem, type ReviewState } from "@kb-agent/storage";
import { MockProvider, OpenAIProvider, type ModelProvider } from "@kb-agent/model";
import { runTurn, startImportBatch, type ToolHandler, type MvpToolName } from "@kb-agent/core";
import { assertInsideWorkspace, createWorkspace, indexWorkspace, workspaceIdForRoot } from "@kb-agent/workspace";
import { appendDebugLog } from "./debugLogger";
import { loadApiKey, readDesktopSettings, saveApiKey, writeDesktopSettings, type SecretStore } from "./secureSettings";
import { isAllowedChannel, type IpcChannel, type IpcResult } from "./ipcContract";
export { allowedChannels, isAllowedChannel } from "./ipcContract";

export interface IpcServices {
  workspaceRoot?: string;
  workspaceId?: string;
  db?: AppDatabase;
  sessionId?: string;
  settingsPath?: string;
  secretStore?: SecretStore;
  activeTurns: Set<string>;
  abortControllers?: Map<string, AbortController>;
  modelProvider?: ModelProvider;
  debugLogPath?: string;
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
  "import:start": z.object({ batchName: z.string(), filePaths: z.array(z.string()).min(1) }),
  "import:get-job": z.object({ id: z.string() }),
  "chat:cancel-turn": z.object({ sessionId: z.string() }),
};

export async function handleIpcRequest(
  services: IpcServices,
  channel: string,
  input: unknown,
): Promise<IpcResult> {
  const startedAt = Date.now();
  let result: IpcResult | undefined;
  try {
    if (!isAllowedChannel(channel)) {
      result = { ok: false, error: "Unknown IPC channel" };
      return result;
    }

    const payload = schemas[channel].parse(input) as Record<string, unknown>;

    switch (channel) {
      case "workspace:create": {
        const workspace = await createWorkspace(payload.rootPath as string);
        await activateWorkspace(services, workspace.rootPath);
        result = { ok: true, data: { ...workspace, workspaceId: services.workspaceId, sessionId: services.sessionId } };
        return result;
      }
      case "workspace:open": {
        await activateWorkspace(services, path.resolve(payload.rootPath as string));
        result = { ok: true, data: { rootPath: services.workspaceRoot, workspaceId: services.workspaceId, sessionId: services.sessionId } };
        return result;
      }
      case "workspace:get-active":
        result = {
          ok: true,
          data: services.workspaceRoot ? { rootPath: services.workspaceRoot, workspaceId: services.workspaceId, sessionId: services.sessionId } : null,
        };
        return result;
      case "settings:get": {
        const settings = await readDesktopSettings(requireSettingsPath(services));
        result = { ok: true, data: { ...settings, hasApiKey: Boolean(await loadApiKey(requireSettingsPath(services), services.secretStore)) } };
        return result;
      }
      case "settings:update": {
        const settingsPath = requireSettingsPath(services);
        if (typeof payload.apiKey === "string" && payload.apiKey.trim()) {
          await saveApiKey(settingsPath, payload.apiKey.trim(), services.secretStore);
        }
        if (typeof payload.modelName === "string") {
          const settings = await readDesktopSettings(settingsPath);
          await writeDesktopSettings(settingsPath, { ...settings, modelName: payload.modelName.trim() || "mock" });
        }
        result = await handleIpcRequest(services, "settings:get", {});
        return result;
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
        result = { ok: true, data: { events } };
        return result;
      }
      case "notes:search": {
        result = { ok: true, data: await searchNotes(requireDatabase(services), payload.query as string, { workspaceId: requireWorkspaceId(services) }) };
        return result;
      }
      case "notes:read": {
        const root = requireWorkspaceRoot(services);
        const targetPath = assertInsideWorkspace(root, payload.path as string);
        result = { ok: true, data: { path: payload.path, content: await readFile(targetPath, "utf8") } };
        return result;
      }
      case "review:list":
        result = { ok: true, data: await listReviewItems(requireDatabase(services), requireWorkspaceId(services), "all") };
        return result;
      case "review:approve":
        result = await approveReviewItem(services, payload.id as string);
        return result;
      case "review:reject":
        result = await approveOrRejectReviewItem(requireDatabase(services), payload.id as string, "rejected");
        return result;
      case "activity:list":
        result = { ok: true, data: await listActivity(requireDatabase(services), requireWorkspaceId(services), 50) };
        return result;
      case "index:rebuild": {
        const indexResult = await indexWorkspace(requireWorkspaceRoot(services), requireDatabase(services));
        await recordActivity(requireDatabase(services), {
          id: randomUUID(),
          workspaceId: indexResult.workspaceId,
          kind: "index",
          title: "Index rebuilt",
          message: `${indexResult.noteCount} notes indexed.`,
          createdAt: new Date().toISOString(),
        });
        result = { ok: true, data: indexResult };
        return result;
      }
      case "import:start": {
        const job = await startImportBatch({
          db: requireDatabase(services),
          workspaceRoot: requireWorkspaceRoot(services),
          workspaceId: requireWorkspaceId(services),
          batchName: payload.batchName as string,
          files: payload.filePaths as string[],
        });
        result = { ok: true, data: job };
        return result;
      }
      case "import:get-job":
        result = { ok: true, data: getImportJob(requireDatabase(services), payload.id as string) };
        return result;
      case "chat:cancel-turn": {
        services.activeTurns.delete(payload.sessionId as string);
        services.abortControllers?.get(payload.sessionId as string)?.abort();
        services.abortControllers?.delete(payload.sessionId as string);
        result = { ok: true, data: { interrupted: true } };
        return result;
      }
    }
    const unhandledResult: IpcResult = { ok: false, error: "Unhandled IPC channel" };
    result = unhandledResult;
    return unhandledResult;
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
    return result;
  } finally {
    const debugEvent = {
      channel,
      ok: result?.ok ?? false,
      durationMs: Date.now() - startedAt,
      ...(services.workspaceRoot ? { workspaceRoot: services.workspaceRoot } : {}),
      ...(result && !result.ok ? { error: result.error } : {}),
      ...optionalDebugDetails(channel, input, result),
    };
    await appendDebugLog(services.debugLogPath, debugEvent).catch((error: unknown) => {
      console.warn("Failed to write debug log", error);
    });
  }
}

function optionalDebugDetails(channel: string, input: unknown, result: IpcResult | undefined): { details?: Record<string, unknown> } {
  const details = debugDetailsFor(channel, input, result);
  return details ? { details } : {};
}

function debugDetailsFor(channel: string, input: unknown, result: IpcResult | undefined): Record<string, unknown> | undefined {
  if (channel === "import:start" && typeof input === "object" && input !== null) {
    const payload = input as { batchName?: unknown; filePaths?: unknown };
    const job = result?.ok && typeof result.data === "object" && result.data !== null ? result.data as { state?: unknown; failureReason?: unknown; summaryNotePath?: unknown } : {};
    return {
      batchName: typeof payload.batchName === "string" ? payload.batchName : undefined,
      fileCount: Array.isArray(payload.filePaths) ? payload.filePaths.length : undefined,
      state: job.state,
      failureReason: job.failureReason,
      summaryNotePath: job.summaryNotePath,
    };
  }

  if (channel === "chat:run-turn" && typeof input === "object" && input !== null) {
    const payload = input as { sessionId?: unknown; message?: unknown };
    return {
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
      messageLength: typeof payload.message === "string" ? payload.message.length : undefined,
    };
  }

  return undefined;
}

function getImportJob(db: AppDatabase, id: string): unknown {
  const row = db.sqlite
    .prepare(
      `SELECT
        id,
        batch_name as batchName,
        state,
        attachment_dir as attachmentDir,
        summary_note_path as summaryNotePath,
        source_files_json as sourceFilesJson,
        completed_at as completedAt,
        failure_reason as failureReason
      FROM import_jobs
      WHERE id = ?`,
    )
    .get(id) as { sourceFilesJson: string | null } | undefined;

  if (!row) {
    return null;
  }

  return {
    ...row,
    sourceFiles: row.sourceFilesJson ? JSON.parse(row.sourceFilesJson) : [],
    sourceFilesJson: undefined,
  };
}

async function approveReviewItem(services: IpcServices, id: string): Promise<IpcResult> {
  const db = requireDatabase(services);
  const item = await getReviewItem(db, id);
  if (!item) {
    return { ok: false, error: "Review item not found" };
  }
  if (item.state === "applied") {
    return { ok: true, data: { id, state: "applied" } };
  }
  if (item.state !== "proposed" && item.state !== "approved") {
    return { ok: false, error: `Review item is already ${item.state}` };
  }

  if (item.proposalType !== "propose_memory") {
    if (item.state === "approved") {
      return { ok: true, data: { id, state: "approved" } };
    }

    await transitionReviewItem(db, id, "proposed", "approved");
    return { ok: true, data: { id, state: "approved" } };
  }

  if (item.state === "proposed") {
    await transitionReviewItem(db, id, "proposed", "approved");
  }

  await applyMemoryProposal(services, item);
  const appliedAt = new Date().toISOString();
  await transitionReviewItem(db, id, "approved", "applied", { appliedAt });
  await recordActivity(db, {
    id: randomUUID(),
    workspaceId: item.workspaceId,
    kind: "review",
    title: "Memory saved",
    message: "Approved memory proposal was saved.",
    entityPath: "02-Profiles/default/Memory.md",
    reviewItemId: id,
    createdAt: appliedAt,
  });
  await indexWorkspace(requireWorkspaceRoot(services), db);

  return { ok: true, data: { id, state: "applied" } };
}

async function approveOrRejectReviewItem(db: AppDatabase, id: string, targetState: Extract<ReviewState, "approved" | "rejected">): Promise<IpcResult> {
  const currentState = await getReviewItemState(db, id);
  if (!currentState) {
    return { ok: false, error: "Review item not found" };
  }
  if (currentState === targetState) {
    return { ok: true, data: { id, state: targetState } };
  }
  if (currentState !== "proposed") {
    return { ok: false, error: `Review item is already ${currentState}` };
  }

  await transitionReviewItem(db, id, "proposed", targetState);
  return { ok: true, data: { id, state: targetState } };
}

async function applyMemoryProposal(services: IpcServices, item: ReviewItem): Promise<void> {
  const body = extractMemoryBody(item.payload);
  if (!body) {
    throw new Error("Memory proposal is missing body");
  }

  const relativePath = "02-Profiles/default/Memory.md";
  const targetPath = assertInsideWorkspace(requireWorkspaceRoot(services), relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const current = await readFile(targetPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      const created = new Date().toISOString().slice(0, 10);
      return `---
title: Default Memory
type: memory
status: active
owner: default
scope: personal
sensitivity: normal
created: ${created}
tags: []
---

# Default Memory
`;
    }
    throw error;
  });
  const bullet = `- ${body}`;
  if (current.includes(bullet) || current.includes(body)) {
    return;
  }

  await writeFile(targetPath, `${current.trimEnd()}\n\n${bullet}\n`, "utf8");
}

function extractMemoryBody(payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null && "body" in payload && typeof payload.body === "string") {
    const body = payload.body.trim();
    return body || null;
  }

  return null;
}

async function activateWorkspace(services: IpcServices, rootPath: string): Promise<void> {
  services.db?.close();
  services.workspaceRoot = path.resolve(rootPath);
  if (services.settingsPath) {
    const settings = await readDesktopSettings(services.settingsPath);
    await writeDesktopSettings(services.settingsPath, { ...settings, workspaceRoot: services.workspaceRoot });
  }
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

export async function restoreWorkspaceFromSettings(services: IpcServices): Promise<boolean> {
  const settings = services.settingsPath ? await readDesktopSettings(services.settingsPath) : {};
  if (!settings.workspaceRoot) {
    return false;
  }

  await activateWorkspace(services, settings.workspaceRoot);
  return true;
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
  handlers.set("search_sessions", async (args) => searchSessions(requireDatabase(services), String((args as { query?: string }).query ?? ""), { workspaceId: requireWorkspaceId(services) }));
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
  const targetPath = typeof payload === "object" && payload && "path" in payload ? String((payload as { path?: string }).path ?? "") : undefined;
  const existingId = findDuplicateReviewItem(db, workspaceId, proposalType, targetPath, payload);
  if (existingId) {
    return { reviewItemId: existingId };
  }

  const id = randomUUID();
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

function findDuplicateReviewItem(
  db: AppDatabase,
  workspaceId: string,
  proposalType: MvpToolName,
  targetPath: string | undefined,
  payload: unknown,
): string | null {
  const rows = db.sqlite
    .prepare(
      `SELECT id, payload_json as payloadJson
      FROM review_items
      WHERE workspace_id = ?
        AND proposal_type = ?
        AND COALESCE(target_path, '') = COALESCE(?, '')
        AND state IN ('proposed', 'approved', 'applied')`,
    )
    .all(workspaceId, proposalType, targetPath ?? null) as Array<{ id: string; payloadJson: string }>;

  const fingerprint = proposalFingerprint(proposalType, payload);
  const duplicate = rows.find((row) => proposalFingerprint(proposalType, parsePayload(row.payloadJson)) === fingerprint);
  return duplicate?.id ?? null;
}

function proposalFingerprint(proposalType: MvpToolName, payload: unknown): string {
  return `${proposalType}:${normalizeProposalPayload(payload)}`;
}

function normalizeProposalPayload(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    if ("body" in payload && typeof payload.body === "string") {
      return normalizeText(payload.body);
    }
    if ("patch" in payload) {
      return stableStringify(payload.patch);
    }
  }

  return stableStringify(payload);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

function parsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson);
  } catch {
    return payloadJson;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function getModelProvider(services: IpcServices): Promise<ModelProvider> {
  if (services.modelProvider) {
    return services.modelProvider;
  }

  const apiKey = services.settingsPath ? await loadApiKey(services.settingsPath, services.secretStore) : null;
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
