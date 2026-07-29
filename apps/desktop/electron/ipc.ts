import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  claimReviewItem,
  createReviewItem,
  getReviewItem,
  listActivity,
  listReviewItems,
  openAppDatabase,
  recordActivity,
  recordActivityOnce,
  renewReviewItemClaim,
  searchNotes,
  searchSessions,
  transitionClaimedReviewItem,
  transitionReviewItem,
  updateReviewItemApplication,
  updateReviewItemPayload,
  type ActivityEvent,
  type AppDatabase,
  type ReviewItem,
} from "@kb-agent/storage";
import { MockProvider, OpenAIProvider, type ModelProvider } from "@kb-agent/model";
import { runTurn, startImportBatch, type ToolHandler, type MvpToolName } from "@kb-agent/core";
import {
  assertInsideWorkspace,
  assertRealPathInsideWorkspace,
  auditWorkspace,
  createWorkspace,
  defaultRoutingPolicy,
  evaluateImportSafety,
  fingerprintImportClassification,
  indexWorkspace,
  mergeImportClassification,
  parseMarkdownDocument,
  serializeMarkdownDocument,
  syncWorkspaceContract,
  type ClassificationSignal,
  workspaceIdForRoot,
  type ContentCategory,
  type ImportClassification,
  type SafetyDecision,
} from "@kb-agent/workspace";
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
  reviewImportFileOps?: Partial<ReviewImportFileOps>;
  reviewApplyHooks?: {
    afterClaim?(reviewItemId: string): Promise<void>;
    afterPromotion?(reviewItemId: string): Promise<void>;
    beforeApplied?(reviewItemId: string): Promise<void>;
  };
  reviewIoHooks?: {
    afterPathSnapshot?(operation: string, targetPath: string): Promise<void>;
  };
}

export interface ReviewImportFileOps {
  mkdir(directoryPath: string): Promise<void>;
  pathExists(targetPath: string): Promise<boolean>;
  readFile(targetPath: string): Promise<Buffer>;
  unlink(targetPath: string): Promise<void>;
  writeFile(targetPath: string, contents: string, exclusive: boolean): Promise<void>;
}

interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: "directory" | "file";
  children?: WorkspaceTreeNode[];
}

const schemas: Record<IpcChannel, z.ZodTypeAny> = {
  "workspace:create": z.object({ rootPath: z.string() }),
  "workspace:open": z.object({ rootPath: z.string() }),
  "workspace:get-active": z.object({}),
  "workspace:audit": z.object({}),
  "workspace:tree": z.object({}),
  "workspace:read-file": z.object({ path: z.string() }),
  "settings:get": z.object({}),
  "settings:update": z.object({ apiKey: z.string().optional(), modelName: z.string().optional() }),
  "chat:run-turn": z.object({ sessionId: z.string(), message: z.string() }),
  "notes:search": z.object({ query: z.string() }),
  "notes:read": z.object({ path: z.string() }),
  "review:list": z.object({}),
  "review:approve": z.object({
    id: z.string(),
    targetPathOverride: z.string().optional(),
    categoryOverride: z.enum([
      "finance.utility",
      "finance.insurance",
      "finance.tax",
      "finance.statement",
      "profile.career",
      "profile.personal_fact",
      "memory.candidate",
      "decision.record",
      "project.document",
      "resource",
      "unknown",
    ]).optional(),
    saveAsRoutingRule: z.boolean().optional(),
    routingRulePattern: z.string().optional(),
  }),
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
      case "workspace:audit": {
        const audit = await auditWorkspace({
          rootPath: requireWorkspaceRoot(services),
          db: requireDatabase(services),
        });
        await recordActivity(requireDatabase(services), {
          id: randomUUID(),
          workspaceId: requireWorkspaceId(services),
          kind: "workspace",
          title: "Workspace audit complete",
          message: `${audit.findings.length} findings, status ${audit.status}.`,
          createdAt: new Date().toISOString(),
        });
        result = { ok: true, data: audit };
        return result;
      }
      case "workspace:tree":
        result = { ok: true, data: await buildWorkspaceTree(requireWorkspaceRoot(services)) };
        return result;
      case "workspace:read-file":
        result = await readWorkspaceFile(requireWorkspaceRoot(services), payload.path as string);
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
            activeProfileId: await getActiveProfileId(services),
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
        result = await approveReviewItem(services, payload.id as string, {
          targetPathOverride: typeof payload.targetPathOverride === "string" ? payload.targetPathOverride : undefined,
          categoryOverride: payload.categoryOverride as ContentCategory | undefined,
          saveAsRoutingRule: payload.saveAsRoutingRule === true,
          routingRulePattern: typeof payload.routingRulePattern === "string" ? payload.routingRulePattern : undefined,
        });
        return result;
      case "review:reject":
        result = await rejectReviewItem(services, payload.id as string);
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

async function buildWorkspaceTree(root: string): Promise<WorkspaceTreeNode> {
  return {
    name: path.basename(root),
    path: "",
    type: "directory",
    children: await readTreeChildren(root, ""),
  };
}

async function readTreeChildren(root: string, relativeDir: string): Promise<WorkspaceTreeNode[]> {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const nodes = await Promise.all(
    entries
      .filter((entry) => shouldShowWorkspaceEntry(entry.name))
      .map(async (entry) => {
        const relativePath = joinWorkspacePath(relativeDir, entry.name);
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            path: relativePath,
            type: "directory" as const,
            children: await readTreeChildren(root, relativePath),
          };
        }
        return {
          name: entry.name,
          path: relativePath,
          type: "file" as const,
        };
      }),
  );

  return nodes.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function shouldShowWorkspaceEntry(name: string): boolean {
  return name !== ".app" && name !== ".git" && name !== "node_modules" && name !== ".DS_Store";
}

function joinWorkspacePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

async function readWorkspaceFile(root: string, relativePath: string): Promise<IpcResult> {
  const targetPath = assertInsideWorkspace(root, relativePath);
  const extension = path.extname(relativePath).toLowerCase();
  if (![".md", ".txt"].includes(extension)) {
    return { ok: true, data: { path: relativePath, content: "Preview is available for Markdown and TXT files in this version.", previewType: "unsupported" } };
  }

  return {
    ok: true,
    data: {
      path: relativePath,
      content: await readFile(targetPath, "utf8"),
      previewType: "text",
    },
  };
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

interface ReviewApproveOptions {
  targetPathOverride?: string | undefined;
  categoryOverride?: ContentCategory | undefined;
  saveAsRoutingRule?: boolean | undefined;
  routingRulePattern?: string | undefined;
}

const reviewClaimLeaseMs = 5 * 60 * 1000;

async function approveReviewItem(services: IpcServices, id: string, options: ReviewApproveOptions = {}): Promise<IpcResult> {
  const db = requireDatabase(services);
  const item = await getReviewItem(db, id);
  if (!item) {
    return { ok: false, error: "Review item not found" };
  }
  if (item.state === "applied") {
    return { ok: true, data: { id, state: "applied" } };
  }
  const claimStartedAt = item.claimStartedAt ? Date.parse(item.claimStartedAt) : Number.NaN;
  const claimIsStale = item.state === "applying"
    && Number.isFinite(claimStartedAt)
    && claimStartedAt < Date.now() - reviewClaimLeaseMs;
  if (item.state === "applying" && !claimIsStale) {
    return { ok: false, error: "Review item is currently applying" };
  }
  if (item.state === "rejecting") {
    return { ok: false, error: "Review item is currently rejecting" };
  }
  if (item.state !== "proposed" && item.state !== "approved" && item.state !== "failed" && !claimIsStale) {
    return { ok: false, error: `Review item is already ${item.state}` };
  }
  if (isImportedSourceNotePayload(item.payload) && item.payload.safetyDecision.decision === "blocked") {
    return { ok: false, error: "Blocked import artifacts cannot be approved" };
  }

  if (item.proposalType === "propose_create_note" || item.proposalType === "propose_decision") {
    const claimToken = randomUUID();
    const claimed = await claimReviewItem(db, id, {
      from: ["proposed", "approved", "failed"],
      to: "applying",
      token: claimToken,
      startedAt: new Date().toISOString(),
      application: reviewApplicationIntent(item, options),
      staleBefore: new Date(Date.now() - reviewClaimLeaseMs).toISOString(),
      ...(claimIsStale && item.claimToken ? { staleClaimToken: item.claimToken } : {}),
    });
    if (!claimed) {
      return reviewClaimConflict(db, id);
    }
    await services.reviewApplyHooks?.afterClaim?.(id);

    let claimedItem = item;
    if (
      item.proposalType === "propose_create_note"
      && hasImportedSourceReference(item.payload)
      && !isImportedSourceNotePayload(item.payload)
    ) {
      try {
        const importedPayload = await reconstructImportedSourcePayload(
          requireWorkspaceRoot(services),
          item.payload,
          reviewImportFileOps(services),
        );
        if (importedPayload.safetyDecision.decision === "blocked") {
          throw new Error("Blocked import artifacts cannot be approved");
        }
        await updateReviewItemPayload(db, id, claimToken, importedPayload);
        claimedItem = { ...item, payload: importedPayload };
      } catch (error) {
        await transitionClaimedReviewItem(db, id, "applying", "failed", claimToken, {
          failureReason: error instanceof Error ? error.message : "Failed to migrate imported Review item",
        });
        throw error;
      }
    }

    let entityPath: string;
    try {
      entityPath = await applyKnowledgeProposal(services, claimedItem, options, {
        previousApplication: item.application,
        onPrepared: async (application) => {
          await updateReviewItemApplication(db, id, claimToken, application);
        },
        ioHooks: services.reviewIoHooks,
        claimFence: reviewClaimFence(db, id, "applying", claimToken),
      });
      await services.reviewApplyHooks?.afterPromotion?.(id);
    } catch (error) {
      await transitionClaimedReviewItem(db, id, "applying", "failed", claimToken, {
        failureReason: error instanceof Error ? error.message : "Failed to apply Review item",
      });
      throw error;
    }
    const appliedAt = new Date().toISOString();
    try {
      const routingDestination = routingDestinationFor(claimedItem, options);
      if (options.saveAsRoutingRule && routingDestination) {
        const routingCategory = routingCategoryFor(claimedItem, options);
        await saveUserRoutingRule(services, claimedItem, {
          destination: routingDestination,
          pattern: options.routingRulePattern?.trim() || routingPatternFor(claimedItem),
          ...(routingCategory === undefined ? {} : { category: routingCategory }),
          createdAt: appliedAt,
        });
      }
      if (item.proposalType === "propose_create_note") {
        await indexWorkspace(requireWorkspaceRoot(services), db);
      }
      await recordActivityOnce(db, {
        id: `review-applied-${id}`,
        workspaceId: item.workspaceId,
        kind: "review",
        title: item.proposalType === "propose_decision" ? "Decision saved" : "Note created",
        message: `Approved ${item.proposalType} proposal was saved.`,
        entityPath,
        reviewItemId: id,
        createdAt: appliedAt,
      });
      await services.reviewApplyHooks?.beforeApplied?.(id);
      await transitionClaimedReviewItem(db, id, "applying", "applied", claimToken, { appliedAt });
    } catch (error) {
      if (!(error instanceof Error && error.message === "Review claim was lost")) {
        await transitionClaimedReviewItem(db, id, "applying", "failed", claimToken, {
          failureReason: error instanceof Error ? error.message : "Failed to finish Review application",
        });
      }
      throw error;
    }

    return { ok: true, data: { id, state: "applied" } };
  }

  if (item.proposalType !== "propose_memory") {
    if (item.state === "approved") {
      return { ok: true, data: { id, state: "approved" } };
    }

    await transitionReviewItem(db, id, "proposed", "approved");
    return { ok: true, data: { id, state: "approved" } };
  }

  const claimToken = randomUUID();
  const claimed = await claimReviewItem(db, id, {
    from: ["proposed", "approved", "failed"],
    to: "applying",
    token: claimToken,
    startedAt: new Date().toISOString(),
    application: { options },
    staleBefore: new Date(Date.now() - reviewClaimLeaseMs).toISOString(),
    ...(claimIsStale && item.claimToken ? { staleClaimToken: item.claimToken } : {}),
  });
  if (!claimed) {
    return reviewClaimConflict(db, id);
  }

  try {
    await applyMemoryProposal(services, item);
    const appliedAt = new Date().toISOString();
    const entityPath = defaultRoutingPolicy.profileMemoryPath(await getActiveProfileId(services));
    await indexWorkspace(requireWorkspaceRoot(services), db);
    await recordActivityOnce(db, {
      id: `review-applied-${id}`,
      workspaceId: item.workspaceId,
      kind: "review",
      title: "Memory saved",
      message: "Approved memory proposal was saved.",
      entityPath,
      reviewItemId: id,
      createdAt: appliedAt,
    });
    await transitionClaimedReviewItem(db, id, "applying", "applied", claimToken, { appliedAt });
  } catch (error) {
    if (!(error instanceof Error && error.message === "Review claim was lost")) {
      await transitionClaimedReviewItem(db, id, "applying", "failed", claimToken, {
        failureReason: error instanceof Error ? error.message : "Failed to apply memory",
      });
    }
    throw error;
  }

  return { ok: true, data: { id, state: "applied" } };
}

async function rejectReviewItem(services: IpcServices, id: string): Promise<IpcResult> {
  const db = requireDatabase(services);
  const item = await getReviewItem(db, id);
  if (!item) {
    return { ok: false, error: "Review item not found" };
  }
  if (item.state === "rejected") {
    return { ok: true, data: { id, state: "rejected" } };
  }
  if (item.state === "applying") {
    return { ok: false, error: "Review item is currently applying" };
  }
  const claimStartedAt = item.claimStartedAt ? Date.parse(item.claimStartedAt) : Number.NaN;
  const claimIsStale = item.state === "rejecting"
    && Number.isFinite(claimStartedAt)
    && claimStartedAt < Date.now() - reviewClaimLeaseMs;
  if (item.state === "rejecting" && !claimIsStale) {
    return { ok: false, error: "Review item is currently rejecting" };
  }
  if (item.state !== "proposed" && item.state !== "failed" && !claimIsStale) {
    return { ok: false, error: `Review item is already ${item.state}` };
  }
  const claimToken = randomUUID();
  const claimed = await claimReviewItem(db, id, {
    from: ["proposed", "failed"],
    to: "rejecting",
    token: claimToken,
    startedAt: new Date().toISOString(),
    staleBefore: new Date(Date.now() - reviewClaimLeaseMs).toISOString(),
    ...(claimIsStale && item.claimToken ? { staleClaimToken: item.claimToken } : {}),
  });
  if (!claimed) {
    return reviewClaimConflict(db, id);
  }

  try {
    if (hasImportedSourceReference(item.payload)) {
      await rejectImportedSourceNote(
        requireWorkspaceRoot(services),
        item.payload.sourceNotePath,
        reviewImportFileOps(services),
        services.reviewIoHooks,
        reviewClaimFence(db, id, "rejecting", claimToken),
      );
    }
    await transitionClaimedReviewItem(db, id, "rejecting", "rejected", claimToken);
  } catch (error) {
    if (!(error instanceof Error && error.message === "Review claim was lost")) {
      await transitionClaimedReviewItem(db, id, "rejecting", "failed", claimToken, {
        failureReason: error instanceof Error ? error.message : "Failed to reject Review item",
      });
    }
    throw error;
  }
  return { ok: true, data: { id, state: "rejected" } };
}

async function reviewClaimConflict(db: AppDatabase, id: string): Promise<IpcResult> {
  const current = await getReviewItem(db, id);
  if (current?.state === "applied") {
    return { ok: true, data: { id, state: "applied" } };
  }
  if (current?.state === "applying") {
    return { ok: false, error: "Review item is currently applying" };
  }
  if (current?.state === "rejecting") {
    return { ok: false, error: "Review item is currently rejecting" };
  }
  return { ok: false, error: `Review item is already ${current?.state ?? "missing"}` };
}

function reviewClaimFence(
  db: AppDatabase,
  id: string,
  state: "applying" | "rejecting",
  claimToken: string,
): () => Promise<void> {
  return async () => {
    const renewed = await renewReviewItemClaim(
      db,
      id,
      state,
      claimToken,
      new Date().toISOString(),
    );
    if (!renewed) {
      throw new Error("Review claim was lost");
    }
  };
}

async function applyMemoryProposal(services: IpcServices, item: ReviewItem): Promise<void> {
  const body = extractMemoryBody(item.payload);
  if (!body) {
    throw new Error("Memory proposal is missing body");
  }

  const activeProfileId = await getActiveProfileId(services);
  const relativePath = defaultRoutingPolicy.profileMemoryPath(activeProfileId);
  const targetPath = assertInsideWorkspace(requireWorkspaceRoot(services), relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const current = await readFile(targetPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      const created = new Date().toISOString().slice(0, 10);
      return `---
title: ${activeProfileId} Memory
type: memory
status: active
owner: ${activeProfileId}
scope: personal
sensitivity: normal
created: ${created}
tags: []
---

# ${activeProfileId} Memory
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

async function applyKnowledgeProposal(
  services: IpcServices,
  item: ReviewItem,
  options: ReviewApproveOptions = {},
  application: {
    previousApplication?: unknown;
    onPrepared?(application: ReviewWriteApplication): Promise<void>;
    ioHooks?: IpcServices["reviewIoHooks"];
    claimFence?: () => Promise<void>;
  } = {},
): Promise<string> {
  if (item.proposalType === "propose_create_note") {
    if (isImportedSourceNotePayload(item.payload)) {
      return moveImportedSourceNote(
        requireWorkspaceRoot(services),
        item,
        item.payload,
        options,
        reviewImportFileOps(services),
        application,
      );
    }
    const payload = createNotePayload(item.payload);
    const relativePath = options.targetPathOverride?.trim() || payload.path;
    const targetPath = assertInsideWorkspace(requireWorkspaceRoot(services), relativePath);
    const prepared = genericWriteApplication(item, relativePath, payload.body, options);
    if (await reviewImportFileOps(services).pathExists(targetPath)) {
      await reconcileGenericWrite(
        requireWorkspaceRoot(services),
        targetPath,
        prepared,
        application.previousApplication,
        application.ioHooks,
      );
      return relativePath;
    }
    await application.onPrepared?.(prepared);
    await secureWriteExclusive(
      requireWorkspaceRoot(services),
      targetPath,
      payload.body,
      reviewImportFileOps(services),
      application.ioHooks,
    );
    return relativePath;
  }

  if (item.proposalType === "propose_decision") {
    const body = extractDecisionBody(item.payload);
    const relativePath = options.targetPathOverride?.trim() || item.targetPath || defaultRoutingPolicy.decisionPath(item.id);
    const targetPath = assertInsideWorkspace(requireWorkspaceRoot(services), relativePath);
    const contents = `${body.trimEnd()}\n`;
    const prepared = genericWriteApplication(item, relativePath, contents, options);
    if (await reviewImportFileOps(services).pathExists(targetPath)) {
      await reconcileGenericWrite(
        requireWorkspaceRoot(services),
        targetPath,
        prepared,
        application.previousApplication,
        application.ioHooks,
      );
      return relativePath;
    }
    await application.onPrepared?.(prepared);
    await secureWriteExclusive(
      requireWorkspaceRoot(services),
      targetPath,
      contents,
      reviewImportFileOps(services),
      application.ioHooks,
    );
    return relativePath;
  }

  throw new Error(`Unsupported proposal apply: ${item.proposalType}`);
}

interface ImportedSourceNotePayload {
  sourceNotePath: string;
  destination?: string;
  classification: ImportClassification;
  safetyDecision: SafetyDecision;
  sourceFile: string;
}

interface ImportMoveApplication {
  kind: "import_move";
  reviewItemId: string;
  sourceNotePath: string;
  destination: string;
  classificationFingerprint: string;
  promotedContentHash: string;
  options: ReviewApproveOptions;
}

interface GenericWriteApplication {
  kind: "exclusive_write";
  reviewItemId: string;
  proposalType: string;
  destination: string;
  promotedContentHash: string;
  options: ReviewApproveOptions;
}

type ReviewWriteApplication = ImportMoveApplication | GenericWriteApplication;

function hasImportedSourceReference(payload: unknown): payload is { sourceNotePath: string; destination?: string } {
  return isRecord(payload)
    && typeof payload.sourceNotePath === "string"
    && (payload.destination === undefined || typeof payload.destination === "string");
}

function isImportedSourceNotePayload(payload: unknown): payload is ImportedSourceNotePayload {
  if (!isRecord(payload) || !isRecord(payload.classification) || !isRecord(payload.safetyDecision)) {
    return false;
  }

  return typeof payload.sourceNotePath === "string"
    && (payload.destination === undefined || typeof payload.destination === "string")
    && typeof payload.sourceFile === "string"
    && typeof payload.classification.primaryCategory === "string"
    && Array.isArray(payload.classification.evidence)
    && Array.isArray(payload.classification.signals)
    && (
      payload.safetyDecision.decision === "auto_write"
      || payload.safetyDecision.decision === "review_required"
      || payload.safetyDecision.decision === "blocked"
    )
    && Array.isArray(payload.safetyDecision.reasonCodes);
}

async function moveImportedSourceNote(
  workspaceRoot: string,
  item: ReviewItem,
  payload: ImportedSourceNotePayload,
  options: ReviewApproveOptions,
  fileOps: ReviewImportFileOps,
  application: {
    previousApplication?: unknown;
    onPrepared?(application: ReviewWriteApplication): Promise<void>;
    ioHooks?: IpcServices["reviewIoHooks"];
    claimFence?: () => Promise<void>;
  },
): Promise<string> {
  const sourcePath = importStagingPath(workspaceRoot, payload.sourceNotePath);
  const destination = options.targetPathOverride?.trim()
    || payload.destination?.trim()
    || payload.classification.suggestedDestination?.trim()
    || "";
  const destinationPath = safeReviewDestination(workspaceRoot, destination);
  const classification = classificationWithCurrentOverrides(item, payload.classification, destination, options);
  const classificationFingerprint = fingerprintImportClassification(classification);
  if (destinationPath !== undefined) {
    await assertRealPathInsideWorkspace(workspaceRoot, destinationPath);
  }
  if (!await fileOps.pathExists(sourcePath)) {
    return reconcileImportedMove(
      workspaceRoot,
      item,
      payload,
      destination,
      classificationFingerprint,
      application.previousApplication,
      fileOps,
    );
  }

  await assertRealPathInsideWorkspace(workspaceRoot, sourcePath, { mustExist: true });
  const body = await secureReadExisting(workspaceRoot, sourcePath, "staging_read", application.ioHooks);
  const document = parseMarkdownDocument(body);
  if (document.frontmatter.status !== "pending_review" || document.frontmatter.route_status !== "pending_review") {
    throw new Error("Imported source note is no longer pending review");
  }
  const updatedBody = updateImportedSourceNoteRoute(
    body,
    sourcePath,
    destinationPath ?? destination,
    destination,
    classification,
  );
  const previous = application.previousApplication;
  if (destinationPath !== undefined
    && await fileOps.pathExists(destinationPath)
    && isImportMoveApplication(previous)) {
    if (previous.reviewItemId !== item.id
      || previous.sourceNotePath !== payload.sourceNotePath
      || previous.destination !== destination
      || previous.classificationFingerprint !== classificationFingerprint
      || previous.promotedContentHash !== hashContents(updatedBody)) {
      throw new Error("Promoted import does not match current Review intent");
    }
    const existing = await secureReadExisting(workspaceRoot, destinationPath, "destination_reconcile", application.ioHooks);
    if (hashContents(existing) !== previous.promotedContentHash) {
      throw new Error("Promoted import does not match the persisted application");
    }
    await secureUnlinkExisting(
      workspaceRoot,
      sourcePath,
      "staging_unlink",
      fileOps,
      application.ioHooks,
      application.claimFence,
    );
    return destination;
  }
  const safetyDecision = evaluateImportSafety({
    workspaceRoot,
    operation: "move",
    destination,
    destinationExists: destinationPath === undefined ? false : await fileOps.pathExists(destinationPath),
    autoWriteThreshold: 0.95,
    classification,
    approval: {
      reviewItemId: item.id,
      destination,
      classificationFingerprint,
    },
  });
  if (safetyDecision.decision !== "auto_write" || safetyDecision.allowedDestination === undefined) {
    throw new Error(`Import approval ${safetyDecision.decision}: ${safetyDecision.reasonCodes.join(", ")}`);
  }

  const approvedDestinationPath = safetyDecision.allowedDestination;
  await assertRealPathInsideWorkspace(workspaceRoot, approvedDestinationPath);
  const approvedBody = destinationPath === approvedDestinationPath
    ? updatedBody
    : updateImportedSourceNoteRoute(body, sourcePath, approvedDestinationPath, destination, classification);
  const preparedApplication: ImportMoveApplication = {
    kind: "import_move",
    reviewItemId: item.id,
    sourceNotePath: payload.sourceNotePath,
    destination,
    classificationFingerprint,
    promotedContentHash: hashContents(approvedBody),
    options,
  };
  await application.onPrepared?.(preparedApplication);
  const createdDestination = await secureWriteExclusive(
    workspaceRoot,
    approvedDestinationPath,
    approvedBody,
    fileOps,
    application.ioHooks,
  );
  try {
    await secureUnlinkExisting(
      workspaceRoot,
      sourcePath,
      "staging_unlink",
      fileOps,
      application.ioHooks,
      application.claimFence,
    );
  } catch (error) {
    try {
      await secureUnlinkExisting(
        workspaceRoot,
        approvedDestinationPath,
        "destination_rollback",
        fileOps,
        undefined,
        application.claimFence,
        createdDestination,
      );
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "unknown rollback failure";
      throw new Error(`${error instanceof Error ? error.message : "Failed to remove staging"}; destination rollback failed: ${rollbackMessage}`);
    }
    throw error;
  }

  return destination;
}

async function reconcileImportedMove(
  workspaceRoot: string,
  item: ReviewItem,
  payload: ImportedSourceNotePayload,
  destination: string,
  classificationFingerprint: string,
  previousApplication: unknown,
  fileOps: ReviewImportFileOps,
): Promise<string> {
  if (!isImportMoveApplication(previousApplication)
    || previousApplication.reviewItemId !== item.id
    || previousApplication.sourceNotePath !== payload.sourceNotePath
    || previousApplication.destination !== destination
    || previousApplication.classificationFingerprint !== classificationFingerprint) {
    throw new Error("Imported source note is missing and cannot be reconciled");
  }
  const destinationPath = assertInsideWorkspace(workspaceRoot, destination);
  await assertRealPathInsideWorkspace(workspaceRoot, destinationPath, { mustExist: true });
  const destinationBody = await secureReadExisting(workspaceRoot, destinationPath, "destination_reconcile");
  if (hashContents(destinationBody) !== previousApplication.promotedContentHash) {
    throw new Error("Promoted import no longer matches the claimed application");
  }
  const document = parseMarkdownDocument(destinationBody);
  if (document.frontmatter.status !== "approved"
    || document.frontmatter.route_status !== "approved"
    || document.frontmatter.route_destination !== destination) {
    throw new Error("Promoted import does not match current Review intent");
  }
  return destination;
}

function isImportMoveApplication(value: unknown): value is ImportMoveApplication {
  return isRecord(value)
    && value.kind === "import_move"
    && typeof value.reviewItemId === "string"
    && typeof value.sourceNotePath === "string"
    && typeof value.destination === "string"
    && typeof value.classificationFingerprint === "string"
    && typeof value.promotedContentHash === "string"
    && isRecord(value.options);
}

function isGenericWriteApplication(value: unknown): value is GenericWriteApplication {
  return isRecord(value)
    && value.kind === "exclusive_write"
    && typeof value.reviewItemId === "string"
    && typeof value.proposalType === "string"
    && typeof value.destination === "string"
    && typeof value.promotedContentHash === "string"
    && isRecord(value.options);
}

function reviewApplicationIntent(item: ReviewItem, options: ReviewApproveOptions): unknown {
  if (isImportMoveApplication(item.application) || isGenericWriteApplication(item.application)) {
    return { ...item.application, options };
  }
  return { options };
}

function genericWriteApplication(
  item: ReviewItem,
  destination: string,
  contents: string,
  options: ReviewApproveOptions,
): GenericWriteApplication {
  return {
    kind: "exclusive_write",
    reviewItemId: item.id,
    proposalType: item.proposalType,
    destination,
    promotedContentHash: hashContents(contents),
    options,
  };
}

async function reconcileGenericWrite(
  workspaceRoot: string,
  targetPath: string,
  prepared: GenericWriteApplication,
  previousApplication: unknown,
  ioHooks?: IpcServices["reviewIoHooks"],
): Promise<void> {
  if (!isGenericWriteApplication(previousApplication)
    || previousApplication.reviewItemId !== prepared.reviewItemId
    || previousApplication.proposalType !== prepared.proposalType
    || previousApplication.destination !== prepared.destination
    || previousApplication.promotedContentHash !== prepared.promotedContentHash) {
    throw new Error("Destination already exists");
  }
  const existing = await secureReadExisting(workspaceRoot, targetPath, "destination_reconcile", ioHooks);
  if (hashContents(existing) !== prepared.promotedContentHash) {
    throw new Error("Existing destination does not match the persisted application");
  }
}

function hashContents(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function classificationWithCurrentOverrides(
  item: ReviewItem,
  classification: ImportClassification,
  destination: string,
  options: ReviewApproveOptions,
): ImportClassification {
  const destinationOverride = options.targetPathOverride?.trim();
  if (options.categoryOverride === undefined && !destinationOverride) {
    return classification;
  }

  return mergeImportClassification({
    signals: [
      ...classification.signals,
      {
        source: "current_user_override",
        ...(options.categoryOverride === undefined ? {} : { category: options.categoryOverride }),
        ...(destinationOverride ? { destination } : {}),
        evidence: [`Review item ${item.id} current override`],
      },
    ],
    fallbackDestination: destination,
  });
}

function updateImportedSourceNoteRoute(
  body: string,
  sourcePath: string,
  destinationPath: string,
  destination: string,
  classification: ImportClassification,
): string {
  const document = parseMarkdownDocument(body);
  const currentSourceLink = document.frontmatter.source_file;
  const nextSourceLink = currentSourceLink
    ? path.relative(path.dirname(destinationPath), path.resolve(path.dirname(sourcePath), currentSourceLink)).split(path.sep).join("/")
    : undefined;
  document.frontmatter = {
    ...document.frontmatter,
    status: "approved",
    tags: ["imported", "approved"],
    content_category: classification.primaryCategory,
    classification_confidence: classification.confidence,
    classification_evidence: classification.evidence,
    route_status: "approved",
    route_destination: destination,
    ...(nextSourceLink ? { source_file: nextSourceLink } : {}),
  };
  document.content = document.content
    .replace(/^- Status: .+$/mu, "- Status: approved")
    .replace(/^- Destination: .+$/mu, `- Destination: ${destination}`);

  if (nextSourceLink) {
    document.content = document.content
      .replace(/(- \[Original file\]\()[^)]+(\))/u, `$1${nextSourceLink}$2`);
  }

  return serializeMarkdownDocument(document);
}

async function rejectImportedSourceNote(
  workspaceRoot: string,
  sourceNotePath: string,
  fileOps: ReviewImportFileOps,
  ioHooks?: IpcServices["reviewIoHooks"],
  claimFence?: () => Promise<void>,
): Promise<void> {
  const sourcePath = importStagingPath(workspaceRoot, sourceNotePath);
  const body = await secureReadExisting(workspaceRoot, sourcePath, "staging_read", ioHooks);
  const document = parseMarkdownDocument(body);
  document.frontmatter = {
    ...document.frontmatter,
    status: "rejected",
    tags: ["imported", "rejected"],
    route_status: "rejected",
  };
  document.content = document.content.replace(/^- Status: .+$/mu, "- Status: rejected");
  const rejectedBody = serializeMarkdownDocument(document);
  await secureRewriteExisting(
    workspaceRoot,
    sourcePath,
    rejectedBody,
    "staging_rewrite",
    ioHooks,
    claimFence,
  );
}

async function reconstructImportedSourcePayload(
  workspaceRoot: string,
  payload: { sourceNotePath: string; destination?: string },
  fileOps: ReviewImportFileOps,
): Promise<ImportedSourceNotePayload> {
  const sourcePath = importStagingPath(workspaceRoot, payload.sourceNotePath);
  await assertRealPathInsideWorkspace(workspaceRoot, sourcePath, { mustExist: true });
  const body = await secureReadExisting(workspaceRoot, sourcePath, "staging_read");
  const { frontmatter } = parseMarkdownDocument(body);
  const category = contentCategoryFrom(frontmatter.content_category);
  const evidence = frontmatter.classification_evidence ?? [];
  const sensitivity = frontmatter.sensitivity === "private" || frontmatter.sensitivity === "sensitive"
    ? "private"
    : frontmatter.safety_reason_codes?.includes("SENSITIVITY_REQUIRES_REVIEW")
      ? "personal"
      : "normal";
  const signal: ClassificationSignal = {
    source: "detector",
    category,
    sensitivity,
    confidence: frontmatter.classification_confidence ?? 0,
    evidence,
    ...(frontmatter.route_destination ? { destination: frontmatter.route_destination } : {}),
  };
  const classification: ImportClassification = {
    primaryCategory: category,
    alternativeCategories: [],
    sensitivity,
    confidence: frontmatter.classification_confidence ?? 0,
    evidence,
    signals: [signal],
    ...((frontmatter.route_destination ?? payload.destination)
      ? { suggestedDestination: frontmatter.route_destination ?? payload.destination }
      : {}),
    conflict: frontmatter.safety_reason_codes?.includes("CLASSIFIER_CONFLICT") ?? false,
  };
  const decision = frontmatter.review_decision ?? "review_required";
  const destination = payload.destination ?? frontmatter.route_destination;
  return {
    sourceNotePath: payload.sourceNotePath,
    ...(destination ? { destination } : {}),
    classification,
    safetyDecision: {
      decision,
      reasonCodes: (frontmatter.safety_reason_codes ?? []) as SafetyDecision["reasonCodes"],
    },
    sourceFile: path.basename(frontmatter.source_file ?? payload.sourceNotePath),
  };
}

function contentCategoryFrom(value: string | undefined): ContentCategory {
  const categories = new Set<ContentCategory>([
    "finance.utility",
    "finance.insurance",
    "finance.tax",
    "finance.statement",
    "profile.career",
    "profile.personal_fact",
    "memory.candidate",
    "decision.record",
    "project.document",
    "resource",
    "unknown",
  ]);
  if (value && categories.has(value as ContentCategory)) {
    return value as ContentCategory;
  }
  return "unknown";
}

function importStagingPath(workspaceRoot: string, sourceNotePath: string): string {
  const sourcePath = assertInsideWorkspace(workspaceRoot, sourceNotePath);
  const relativePath = path.relative(path.resolve(workspaceRoot), sourcePath).split(path.sep).join("/");
  if (!relativePath.startsWith(".app/import-staging/")) {
    throw new Error("Imported source note is not in staging");
  }
  return sourcePath;
}

function safeReviewDestination(workspaceRoot: string, destination: string): string | undefined {
  try {
    return assertInsideWorkspace(workspaceRoot, destination);
  } catch {
    return undefined;
  }
}

function reviewImportFileOps(services: IpcServices): ReviewImportFileOps {
  return { ...defaultReviewImportFileOps, ...services.reviewImportFileOps };
}

interface PathIdentity {
  targetPath: string;
  parentPath: string;
  parentRealPath: string;
  parentDev: number;
  parentIno: number;
  fileDev?: number;
  fileIno?: number;
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

// Node exposes O_NOFOLLOW but not openat/unlinkat. These checks close deterministic
// ancestor-swap windows around each operation; an OS-level rename after the final
// identity check cannot be made fully race-free without directory-relative syscalls.
async function secureReadExisting(
  workspaceRoot: string,
  targetPath: string,
  operation: string,
  ioHooks?: IpcServices["reviewIoHooks"],
): Promise<string> {
  const identity = await capturePathIdentity(workspaceRoot, targetPath, true);
  await ioHooks?.afterPathSnapshot?.(operation, targetPath);
  await revalidatePathIdentity(workspaceRoot, identity, true);
  const handle = await open(
    targetPath,
    constants.O_RDONLY | noFollowFlag(),
  );
  try {
    await assertHandleIdentity(handle, identity);
    await revalidatePathIdentity(workspaceRoot, identity, true);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function secureRewriteExisting(
  workspaceRoot: string,
  targetPath: string,
  contents: string,
  operation: string,
  ioHooks?: IpcServices["reviewIoHooks"],
  claimFence?: () => Promise<void>,
): Promise<void> {
  const identity = await capturePathIdentity(workspaceRoot, targetPath, true);
  await ioHooks?.afterPathSnapshot?.(operation, targetPath);
  await revalidatePathIdentity(workspaceRoot, identity, true);
  const handle = await open(
    targetPath,
    constants.O_WRONLY | noFollowFlag(),
  );
  try {
    await assertHandleIdentity(handle, identity);
    await revalidatePathIdentity(workspaceRoot, identity, true);
    // Node cannot atomically couple rename() to the SQLite claim CAS. Renewing
    // immediately before mutating the verified open inode avoids that rename gap.
    await claimFence?.();
    await handle.truncate(0);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await revalidatePathIdentity(workspaceRoot, identity, true);
}

async function secureUnlinkExisting(
  workspaceRoot: string,
  targetPath: string,
  operation: string,
  fileOps: ReviewImportFileOps,
  ioHooks?: IpcServices["reviewIoHooks"],
  claimFence?: () => Promise<void>,
  expectedIdentity?: PathIdentity,
): Promise<void> {
  const identity = await capturePathIdentity(workspaceRoot, targetPath, true);
  if (expectedIdentity && !samePathIdentity(identity, expectedIdentity)) {
    throw new Error("Destination identity changed before rollback");
  }
  await ioHooks?.afterPathSnapshot?.(operation, targetPath);
  await revalidatePathIdentity(workspaceRoot, identity, true);
  await claimFence?.();
  await fileOps.unlink(targetPath);
}

async function secureWriteExclusive(
  workspaceRoot: string,
  targetPath: string,
  contents: string,
  fileOps: ReviewImportFileOps,
  ioHooks?: IpcServices["reviewIoHooks"],
): Promise<PathIdentity> {
  const nearestParent = await captureNearestExistingDirectory(workspaceRoot, path.dirname(targetPath));
  await fileOps.mkdir(path.dirname(targetPath));
  await revalidateDirectoryIdentity(workspaceRoot, nearestParent);
  const identity = await capturePathIdentity(workspaceRoot, targetPath, false);
  await ioHooks?.afterPathSnapshot?.("destination_create", targetPath);
  await revalidatePathIdentity(workspaceRoot, identity, false);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let wroteContent = false;
  let createdIdentity: PathIdentity | undefined;
  try {
    handle = await open(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    const created = await handle.stat();
    createdIdentity = {
      ...identity,
      fileDev: created.dev,
      fileIno: created.ino,
    };
    await revalidatePathIdentity(workspaceRoot, createdIdentity, true);
    await assertHandleIdentity(handle, createdIdentity);
    await handle.writeFile(contents, "utf8");
    wroteContent = true;
    await handle.sync();
    await revalidatePathIdentity(workspaceRoot, createdIdentity, true);
  } catch (error) {
    if (handle && !wroteContent) {
      await removeVerifiedEmptyCreatedFile(workspaceRoot, targetPath, handle).catch(() => undefined);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (!createdIdentity) {
    throw new Error("Destination identity was not captured");
  }
  return createdIdentity;
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.targetPath === right.targetPath
    && left.parentRealPath === right.parentRealPath
    && left.parentDev === right.parentDev
    && left.parentIno === right.parentIno
    && left.fileDev === right.fileDev
    && left.fileIno === right.fileIno;
}

async function captureNearestExistingDirectory(
  workspaceRoot: string,
  targetDirectory: string,
): Promise<DirectoryIdentity> {
  const normalizedDirectory = assertInsideWorkspace(workspaceRoot, targetDirectory);
  await assertNoSymlinkAncestors(workspaceRoot, normalizedDirectory);
  let current = normalizedDirectory;
  while (true) {
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("Path resolves outside workspace");
      }
      const realPath = await realpath(current);
      await assertCanonicalInsideWorkspace(workspaceRoot, realPath);
      return { path: current, realPath, dev: entry.dev, ino: entry.ino };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function revalidateDirectoryIdentity(
  workspaceRoot: string,
  identity: DirectoryIdentity,
): Promise<void> {
  await assertNoSymlinkAncestors(workspaceRoot, identity.path);
  const entry = await lstat(identity.path);
  const realPath = await realpath(identity.path);
  if (
    !entry.isDirectory()
    || entry.isSymbolicLink()
    || entry.dev !== identity.dev
    || entry.ino !== identity.ino
    || realPath !== identity.realPath
  ) {
    throw new Error("Path identity changed during secure IO");
  }
}

async function capturePathIdentity(
  workspaceRoot: string,
  targetPath: string,
  includeFile: boolean,
): Promise<PathIdentity> {
  const normalizedTarget = assertInsideWorkspace(workspaceRoot, targetPath);
  await assertNoSymlinkAncestors(workspaceRoot, includeFile ? normalizedTarget : path.dirname(normalizedTarget));
  const parentPath = path.dirname(normalizedTarget);
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("Path resolves outside workspace");
  }
  const parentRealPath = await realpath(parentPath);
  await assertCanonicalInsideWorkspace(workspaceRoot, parentRealPath);
  const identity: PathIdentity = {
    targetPath: normalizedTarget,
    parentPath,
    parentRealPath,
    parentDev: parent.dev,
    parentIno: parent.ino,
  };
  if (includeFile) {
    const file = await lstat(normalizedTarget);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error("Path resolves outside workspace");
    }
    identity.fileDev = file.dev;
    identity.fileIno = file.ino;
    await assertRealPathInsideWorkspace(workspaceRoot, normalizedTarget, { mustExist: true });
  }
  return identity;
}

async function assertCanonicalInsideWorkspace(workspaceRoot: string, canonicalPath: string): Promise<void> {
  const canonicalRoot = await realpath(workspaceRoot);
  const relative = path.relative(canonicalRoot, canonicalPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path resolves outside workspace");
  }
}

async function revalidatePathIdentity(
  workspaceRoot: string,
  identity: PathIdentity,
  includeFile: boolean,
): Promise<void> {
  await assertNoSymlinkAncestors(workspaceRoot, includeFile ? identity.targetPath : identity.parentPath);
  const parent = await lstat(identity.parentPath);
  const parentRealPath = await realpath(identity.parentPath);
  if (
    !parent.isDirectory()
    || parent.isSymbolicLink()
    || parent.dev !== identity.parentDev
    || parent.ino !== identity.parentIno
    || parentRealPath !== identity.parentRealPath
  ) {
    throw new Error("Path identity changed during secure IO");
  }
  if (includeFile) {
    const file = await lstat(identity.targetPath);
    if (
      !file.isFile()
      || file.isSymbolicLink()
      || file.dev !== identity.fileDev
      || file.ino !== identity.fileIno
    ) {
      throw new Error("Path identity changed during secure IO");
    }
    await assertRealPathInsideWorkspace(workspaceRoot, identity.targetPath, { mustExist: true });
  }
}

async function assertHandleIdentity(
  handle: Awaited<ReturnType<typeof open>>,
  identity: PathIdentity,
): Promise<void> {
  const file = await handle.stat();
  if (!file.isFile() || file.dev !== identity.fileDev || file.ino !== identity.fileIno) {
    throw new Error("Path identity changed during secure IO");
  }
}

async function assertNoSymlinkAncestors(workspaceRoot: string, targetPath: string): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const target = assertInsideWorkspace(root, targetPath);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error("Path resolves outside workspace");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

async function removeVerifiedEmptyCreatedFile(
  workspaceRoot: string,
  targetPath: string,
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> {
  const opened = await handle.stat();
  if (opened.size !== 0) {
    return;
  }
  const canonicalPath = await realpath(targetPath);
  const canonical = await lstat(canonicalPath);
  if (
    canonical.isSymbolicLink()
    || canonical.dev !== opened.dev
    || canonical.ino !== opened.ino
    || canonical.size !== 0
  ) {
    return;
  }
  const canonicalRoot = await realpath(workspaceRoot);
  const relative = path.relative(canonicalRoot, canonicalPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    await unlink(canonicalPath);
    return;
  }
  await unlink(canonicalPath);
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

const defaultReviewImportFileOps: ReviewImportFileOps = {
  mkdir: async (directoryPath) => {
    await mkdir(directoryPath, { recursive: true });
  },
  pathExists: async (targetPath) => access(targetPath).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  ),
  readFile: async (targetPath) => readFile(targetPath),
  unlink: async (targetPath) => unlink(targetPath),
  writeFile: async (targetPath, contents, exclusive) => writeFile(
    targetPath,
    contents,
    { encoding: "utf8", flag: exclusive ? "wx" : "w" },
  ),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface UserRoutingRule {
  id: string;
  pattern: string;
  category?: ContentCategory;
  destination: string;
  sourceReviewItemId: string;
  createdAt: string;
}

async function saveUserRoutingRule(
  services: IpcServices,
  item: ReviewItem,
  input: { pattern: string; category?: ContentCategory; destination: string; createdAt: string },
): Promise<void> {
  const workspaceRoot = requireWorkspaceRoot(services);
  const rule: UserRoutingRule = {
    id: `routing-rule-${item.id}`,
    pattern: input.pattern,
    ...(input.category === undefined ? {} : { category: input.category }),
    destination: input.destination,
    sourceReviewItemId: item.id,
    createdAt: input.createdAt,
  };

  await appendRoutingPolicyRule(workspaceRoot, rule);
  await appendAgentsRoutingRule(workspaceRoot, rule);
  await writeRoutingRuleAdr(workspaceRoot, rule);
}

async function appendRoutingPolicyRule(workspaceRoot: string, rule: UserRoutingRule): Promise<void> {
  const policyPath = assertInsideWorkspace(workspaceRoot, ".vault/routing-policy.json");
  await mkdir(path.dirname(policyPath), { recursive: true });
  const existing = await readFile(policyPath, "utf8")
    .then((content) => JSON.parse(content) as { version?: number; rules?: UserRoutingRule[] })
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { version: 1, rules: [] };
      }
      throw error;
    });
  const rules = existing.rules ?? [];
  if (!rules.some((existingRule) => existingRule.id === rule.id)) {
    rules.push(rule);
  }
  await writeFile(policyPath, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, "utf8");
}

async function appendAgentsRoutingRule(workspaceRoot: string, rule: UserRoutingRule): Promise<void> {
  const agentsPath = assertInsideWorkspace(workspaceRoot, "AGENTS.md");
  const current = await readFile(agentsPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "# Workspace Contract\n";
    }
    throw error;
  });
  const ruleLine = `- ${rule.pattern} -> ${rule.destination}`;
  if (current.includes(ruleLine)) {
    return;
  }
  const heading = "## User Routing Rules";
  const next = current.includes(heading)
    ? current.replace(heading, `${heading}\n${ruleLine}`)
    : `${current.trimEnd()}\n\n${heading}\n\n${ruleLine}\n`;
  await writeFile(agentsPath, next, "utf8");
}

async function writeRoutingRuleAdr(workspaceRoot: string, rule: UserRoutingRule): Promise<void> {
  const adrPath = assertInsideWorkspace(workspaceRoot, defaultRoutingPolicy.decisionPath(rule.id));
  await mkdir(path.dirname(adrPath), { recursive: true });
  const contents = `# User-defined routing rule

**Date:** ${rule.createdAt.slice(0, 10)}
**Status:** Accepted

## Context

During Review, the user chose a different destination for a proposed knowledge write and saved that choice as a future routing rule.

## Decision

Route imports or proposals matching:

\`\`\`text
${rule.pattern}
\`\`\`

to:

\`\`\`text
${rule.destination}
\`\`\`

## Consequences

- The workspace routing policy records this rule in \`.vault/routing-policy.json\`.
- The workspace contract records the user-readable rule in \`AGENTS.md\`.
- The source Review item is \`${rule.sourceReviewItemId}\`.
`;
  try {
    await writeFile(adrPath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    const existing = await readFile(adrPath, "utf8");
    if (!existing.includes(`The source Review item is \`${rule.sourceReviewItemId}\`.`)) {
      throw new Error("Saved routing rule ADR conflicts with an existing file");
    }
  }
}

function routingPatternFor(item: ReviewItem): string {
  if (item.targetPath) {
    return path.basename(item.targetPath, path.extname(item.targetPath));
  }
  const payload = item.payload;
  if (typeof payload === "object" && payload !== null && "path" in payload && typeof payload.path === "string") {
    return path.basename(payload.path, path.extname(payload.path));
  }
  return item.proposalType;
}

function routingDestinationFor(item: ReviewItem, options: ReviewApproveOptions): string | undefined {
  const override = options.targetPathOverride?.trim();
  if (override) {
    return override;
  }
  if (isImportedSourceNotePayload(item.payload)) {
    return item.payload.destination?.trim() || item.payload.classification.suggestedDestination?.trim();
  }
  return item.targetPath?.trim();
}

function routingCategoryFor(item: ReviewItem, options: ReviewApproveOptions): ContentCategory | undefined {
  if (options.categoryOverride !== undefined) {
    return options.categoryOverride;
  }
  return isImportedSourceNotePayload(item.payload)
    ? item.payload.classification.primaryCategory
    : undefined;
}

function createNotePayload(payload: unknown): { path: string; body: string } {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "path" in payload &&
    typeof payload.path === "string" &&
    "body" in payload &&
    typeof payload.body === "string" &&
    payload.path.trim() &&
    payload.body.trim()
  ) {
    return { path: payload.path.trim(), body: payload.body };
  }

  throw new Error("Create-note proposal is missing path or body");
}

function extractDecisionBody(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "body" in payload && typeof payload.body === "string") {
    const body = payload.body.trim();
    if (body) {
      return body;
    }
  }

  throw new Error("Decision proposal is missing body");
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
  await syncWorkspaceContract(services.workspaceRoot);
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
  handlers.set("get_profile", async () => readActiveProfileContext(services));

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
  if (proposalType === "propose_memory" && await memoryAlreadyExists(requireWorkspaceRoot(services), await getActiveProfileId(services), payload)) {
    return { reviewItemId: "skipped-existing-memory" };
  }
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

async function memoryAlreadyExists(workspaceRoot: string, activeProfileId: string, payload: unknown): Promise<boolean> {
  const body = memoryBody(payload);
  if (!body) {
    return false;
  }

  try {
    const memory = await readFile(path.join(workspaceRoot, defaultRoutingPolicy.profileMemoryPath(activeProfileId)), "utf8");
    return normalizeText(memory).includes(normalizeText(body));
  } catch {
    return false;
  }
}

async function readActiveProfileContext(services: IpcServices): Promise<{ content: string }> {
  const workspaceRoot = requireWorkspaceRoot(services);
  const activeProfileId = await getActiveProfileId(services);
  const [profile, memory] = await Promise.all([
    readOptionalWorkspaceFile(workspaceRoot, defaultRoutingPolicy.profilePath(activeProfileId)),
    readOptionalWorkspaceFile(workspaceRoot, defaultRoutingPolicy.profileMemoryPath(activeProfileId)),
  ]);

  return {
    content: [
      `Active profile: ${activeProfileId}`,
      "",
      "## Profile",
      profile,
      "",
      "## Memory",
      memory,
    ].join("\n").trim(),
  };
}

async function getActiveProfileId(services: IpcServices): Promise<string> {
  const settings = services.settingsPath ? await readDesktopSettings(services.settingsPath) : {};
  return settings.activeProfileId?.trim() || "default";
}

async function readOptionalWorkspaceFile(workspaceRoot: string, relativePath: string): Promise<string> {
  try {
    return await readFile(assertInsideWorkspace(workspaceRoot, relativePath), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function memoryBody(payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null && "body" in payload && typeof payload.body === "string") {
    return payload.body;
  }

  return null;
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
