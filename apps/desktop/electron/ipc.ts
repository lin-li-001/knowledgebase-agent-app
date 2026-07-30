import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  claimReviewItem,
  createReviewItem,
  expireReviewItemClaims,
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
  assertApprovedImportFinalNotePath,
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
  recoverImportPromotions,
  secureAtomicReplaceWorkspaceFile,
  securePublishWorkspaceFileAtomic,
  secureReadWorkspaceArtifact,
  secureRemoveWorkspaceArtifact,
  secureRewriteWorkspaceFile,
  secureWorkspacePathExists,
  serializeMarkdownDocument,
  syncWorkspaceContract,
  withWorkspaceWriteLock,
  type ClassificationSignal,
  workspaceIdForRoot,
  type ContentCategory,
  type ImportClassification,
  type SafetyDecision,
  type SecureWorkspaceArtifactIdentity,
  type SecureWorkspaceIoHooks,
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
  reviewIoHooks?: SecureWorkspaceIoHooks;
}

export interface ReviewImportFileOps {
  unlink(targetPath: string): Promise<void>;
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
      case "review:list": {
        const db = requireDatabase(services);
        const workspaceId = requireWorkspaceId(services);
        await expireReviewItemClaims(
          db,
          workspaceId,
          staleReviewClaimCutoff(),
        );
        result = { ok: true, data: await listReviewItems(db, workspaceId, "all") };
        return result;
      }
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
  await expireReviewItemClaims(
    db,
    requireWorkspaceId(services),
    staleReviewClaimCutoff(),
  );
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
      const routingDestination = isImportedSourceNotePayload(claimedItem.payload)
        ? entityPath
        : routingDestinationFor(claimedItem, options);
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
  await expireReviewItemClaims(
    db,
    requireWorkspaceId(services),
    staleReviewClaimCutoff(),
  );
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
  if (item.application !== undefined && item.application !== null) {
    return {
      ok: false,
      error: "Review item has a prepared application; resume approval instead",
    };
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

function staleReviewClaimCutoff(): string {
  return new Date(Date.now() - reviewClaimLeaseMs).toISOString();
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
    if (await secureWorkspacePathExists(requireWorkspaceRoot(services), targetPath)) {
      await reconcileGenericWrite(
        requireWorkspaceRoot(services),
        targetPath,
        prepared,
        application.previousApplication,
        application.ioHooks,
      );
      return relativePath;
    }
    await publishGenericWrite(
      requireWorkspaceRoot(services),
      targetPath,
      payload.body,
      prepared,
      application.ioHooks,
      application.onPrepared,
    );
    return relativePath;
  }

  if (item.proposalType === "propose_decision") {
    const body = extractDecisionBody(item.payload);
    const relativePath = options.targetPathOverride?.trim() || item.targetPath || defaultRoutingPolicy.decisionPath(item.id);
    const targetPath = assertInsideWorkspace(requireWorkspaceRoot(services), relativePath);
    const contents = `${body.trimEnd()}\n`;
    const prepared = genericWriteApplication(item, relativePath, contents, options);
    if (await secureWorkspacePathExists(requireWorkspaceRoot(services), targetPath)) {
      await reconcileGenericWrite(
        requireWorkspaceRoot(services),
        targetPath,
        prepared,
        application.previousApplication,
        application.ioHooks,
      );
      return relativePath;
    }
    await publishGenericWrite(
      requireWorkspaceRoot(services),
      targetPath,
      contents,
      prepared,
      application.ioHooks,
      application.onPrepared,
    );
    return relativePath;
  }

  throw new Error(`Unsupported proposal apply: ${item.proposalType}`);
}

async function publishGenericWrite(
  workspaceRoot: string,
  targetPath: string,
  contents: string,
  prepared: GenericWriteApplication,
  ioHooks?: SecureWorkspaceIoHooks,
  onPrepared?: (application: ReviewWriteApplication) => Promise<void>,
): Promise<void> {
  await securePublishWorkspaceFileAtomic(
    workspaceRoot,
    targetPath,
    contents,
    {
      operation: "destination_create",
      hooks: ioHooks,
      afterTempSync: async (temp) => {
        await onPrepared?.({
          ...prepared,
          finalTemp: recordReviewArtifact(workspaceRoot, temp),
        });
      },
      afterPublish: async (final, temp) => {
        await onPrepared?.({
          ...prepared,
          finalTemp: recordReviewArtifact(workspaceRoot, temp),
          final: recordReviewArtifact(workspaceRoot, final),
        });
      },
    },
  );
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
  attachment: RecordedReviewArtifact;
  staging: RecordedReviewArtifact;
  expectedFinalHash: string;
  promotedContentHash: string;
  finalTemp?: RecordedReviewArtifact;
  final?: RecordedReviewArtifact;
  options: ReviewApproveOptions;
}

interface GenericWriteApplication {
  kind: "exclusive_write";
  reviewItemId: string;
  proposalType: string;
  destination: string;
  expectedFinalHash: string;
  promotedContentHash: string;
  finalTemp?: RecordedReviewArtifact;
  final?: RecordedReviewArtifact;
  options: ReviewApproveOptions;
}

interface RecordedReviewArtifact {
  path: string;
  parentPath: string;
  parentRealPath: string;
  parentDev: number;
  parentIno: number;
  dev: number;
  ino: number;
  sha256: string;
  size: number;
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
  const persistedDestination = await reconcilePersistedImportedApplication(
    workspaceRoot,
    item,
    payload,
    application.previousApplication,
    fileOps,
    application.ioHooks,
    application.claimFence,
  );
  if (persistedDestination !== undefined) {
    return persistedDestination;
  }
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
  if (!await secureWorkspacePathExists(workspaceRoot, sourcePath)) {
    throw new Error("Imported source note is missing and cannot be reconciled");
  }

  const staging = await secureReadWorkspaceArtifact(
    workspaceRoot,
    sourcePath,
    { operation: "staging_read", hooks: application.ioHooks },
  );
  const body = staging.contents.toString("utf8");
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
  const safetyDecision = evaluateImportSafety({
    workspaceRoot,
    operation: "move",
    destination,
    destinationExists: destinationPath === undefined
      ? false
      : await secureWorkspacePathExists(workspaceRoot, destinationPath),
    autoWriteThreshold: 0.95,
    classification,
    approval: {
      reviewItemId: item.id,
      destination,
      classificationFingerprint,
    },
  });
  if (safetyDecision.decision !== "auto_write") {
    throw new Error(`Import approval ${safetyDecision.decision}: ${safetyDecision.reasonCodes.join(", ")}`);
  }
  if (safetyDecision.allowedDestination === undefined) {
    throw new Error("Import approval is missing an allowed destination");
  }

  const approvedDestinationPath = safetyDecision.allowedDestination;
  await assertRealPathInsideWorkspace(workspaceRoot, approvedDestinationPath);
  const approvedBody = destinationPath === approvedDestinationPath
    ? updatedBody
    : updateImportedSourceNoteRoute(body, sourcePath, approvedDestinationPath, destination, classification);
  const attachment = await readReviewedImportAttachment(
    workspaceRoot,
    sourcePath,
    body,
    application.ioHooks,
  );
  let preparedApplication: ImportMoveApplication = {
    kind: "import_move",
    reviewItemId: item.id,
    sourceNotePath: payload.sourceNotePath,
    destination,
    classificationFingerprint,
    attachment: recordReviewArtifact(workspaceRoot, attachment.artifact),
    staging: recordReviewArtifact(workspaceRoot, staging.artifact),
    expectedFinalHash: hashContents(approvedBody),
    promotedContentHash: hashContents(approvedBody),
    options,
  };
  await application.onPrepared?.(preparedApplication);
  try {
    await securePublishWorkspaceFileAtomic(
      workspaceRoot,
      approvedDestinationPath,
      approvedBody,
      {
        operation: "destination_create",
        hooks: application.ioHooks,
        afterTempSync: async (temp) => {
          preparedApplication = {
            ...preparedApplication,
            finalTemp: recordReviewArtifact(workspaceRoot, temp),
          };
          await application.onPrepared?.(preparedApplication);
        },
        afterPublish: async (final, temp) => {
          preparedApplication = {
            ...preparedApplication,
            finalTemp: recordReviewArtifact(workspaceRoot, temp),
            final: recordReviewArtifact(workspaceRoot, final),
          };
          await application.onPrepared?.(preparedApplication);
        },
      },
    );
    await verifyReviewedImportBindings(
      workspaceRoot,
      preparedApplication,
      application.ioHooks,
    );
    await secureRemoveWorkspaceArtifact(
      workspaceRoot,
      artifactFromReviewRecord(
        workspaceRoot,
        preparedApplication.staging,
      ),
      {
        operation: "staging_retire",
        hooks: application.ioHooks,
        claimFence: application.claimFence,
        unlinkFile: fileOps.unlink,
      },
    );
  } catch (error) {
    if (!preparedApplication.final) {
      throw error;
    }
    try {
      await secureRemoveWorkspaceArtifact(
        workspaceRoot,
        artifactFromReviewRecord(
          workspaceRoot,
          preparedApplication.final,
        ),
        {
          operation: "destination_rollback",
          hooks: application.ioHooks,
          claimFence: application.claimFence,
          unlinkFile: fileOps.unlink,
        },
      );
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "unknown rollback failure";
      throw new Error(`${error instanceof Error ? error.message : "Failed to remove staging"}; destination rollback failed: ${rollbackMessage}`);
    }
    throw error;
  }

  return destination;
}

async function readReviewedImportAttachment(
  workspaceRoot: string,
  stagingPath: string,
  stagingBody: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<Awaited<ReturnType<typeof secureReadWorkspaceArtifact>>> {
  const sourceFile = parseMarkdownDocument(stagingBody).frontmatter.source_file;
  if (typeof sourceFile !== "string" || sourceFile.trim() === "") {
    throw new Error("Imported source note is missing its attachment binding");
  }
  const attachmentPath = assertInsideWorkspace(
    workspaceRoot,
    path.resolve(
      path.dirname(stagingPath),
      sourceFile.replace(/\\([()\\])/gu, "$1"),
    ),
  );
  const relativeAttachment = reviewRelativePath(workspaceRoot, attachmentPath);
  if (!relativeAttachment.startsWith(`${defaultRoutingPolicy.importAttachmentRoot()}/`)) {
    throw new Error("Imported source note attachment is outside the import attachment root");
  }
  return secureReadWorkspaceArtifact(workspaceRoot, attachmentPath, {
    operation: "attachment_read",
    hooks: ioHooks,
  });
}

async function verifyReviewedImportBindings(
  workspaceRoot: string,
  application: ImportMoveApplication,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  let staging;
  try {
    staging = await secureReadWorkspaceArtifact(
      workspaceRoot,
      artifactFromReviewRecord(workspaceRoot, application.staging).targetPath,
      {
        operation: "staging_retire",
        hooks: ioHooks,
        expectedArtifact: artifactFromReviewRecord(
          workspaceRoot,
          application.staging,
        ),
      },
    );
  } catch {
    throw new Error("Review staging artifact changed before retirement");
  }
  let attachment;
  try {
    attachment = await secureReadWorkspaceArtifact(
      workspaceRoot,
      artifactFromReviewRecord(workspaceRoot, application.attachment).targetPath,
      {
        operation: "attachment_retire",
        expectedArtifact: artifactFromReviewRecord(
          workspaceRoot,
          application.attachment,
        ),
      },
    );
  } catch {
    throw new Error("Review attachment changed before retirement");
  }
  const rebound = await readReviewedImportAttachment(
    workspaceRoot,
    staging.artifact.targetPath,
    staging.contents.toString("utf8"),
  );
  if (
    rebound.artifact.targetPath !== attachment.artifact.targetPath
    || rebound.artifact.sha256 !== attachment.artifact.sha256
    || rebound.artifact.fileDev !== attachment.artifact.fileDev
    || rebound.artifact.fileIno !== attachment.artifact.fileIno
  ) {
    throw new Error("Review attachment binding changed before retirement");
  }
}

function isImportMoveApplication(value: unknown): value is ImportMoveApplication {
  return isRecord(value)
    && value.kind === "import_move"
    && typeof value.reviewItemId === "string"
    && typeof value.sourceNotePath === "string"
    && typeof value.destination === "string"
    && typeof value.classificationFingerprint === "string"
    && isRecordedReviewArtifact(value.attachment)
    && isRecordedReviewArtifact(value.staging)
    && typeof value.expectedFinalHash === "string"
    && typeof value.promotedContentHash === "string"
    && (value.finalTemp === undefined || isRecordedReviewArtifact(value.finalTemp))
    && (value.final === undefined || isRecordedReviewArtifact(value.final))
    && isRecord(value.options);
}

function isGenericWriteApplication(value: unknown): value is GenericWriteApplication {
  return isRecord(value)
    && value.kind === "exclusive_write"
    && typeof value.reviewItemId === "string"
    && typeof value.proposalType === "string"
    && typeof value.destination === "string"
    && typeof value.expectedFinalHash === "string"
    && typeof value.promotedContentHash === "string"
    && (value.finalTemp === undefined || isRecordedReviewArtifact(value.finalTemp))
    && (value.final === undefined || isRecordedReviewArtifact(value.final))
    && isRecord(value.options);
}

function isRecordedReviewArtifact(value: unknown): value is RecordedReviewArtifact {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.parentPath === "string"
    && typeof value.parentRealPath === "string"
    && typeof value.parentDev === "number"
    && typeof value.parentIno === "number"
    && typeof value.dev === "number"
    && typeof value.ino === "number"
    && typeof value.sha256 === "string"
    && typeof value.size === "number";
}

function reviewApplicationIntent(item: ReviewItem, options: ReviewApproveOptions): unknown {
  if (isImportMoveApplication(item.application) || isGenericWriteApplication(item.application)) {
    return item.application;
  }
  return { options };
}

async function reconcilePersistedImportedApplication(
  workspaceRoot: string,
  item: ReviewItem,
  payload: ImportedSourceNotePayload,
  previousApplication: unknown,
  fileOps: ReviewImportFileOps,
  ioHooks?: IpcServices["reviewIoHooks"],
  claimFence?: () => Promise<void>,
): Promise<string | undefined> {
  if (!isImportMoveApplication(previousApplication)) {
    return undefined;
  }
  if (
    previousApplication.reviewItemId !== item.id
    || previousApplication.sourceNotePath !== payload.sourceNotePath
  ) {
    throw new Error("Persisted import application does not match its Review item");
  }

  const persistedPath = assertApprovedImportFinalNotePath(
    workspaceRoot,
    previousApplication.destination,
  );
  const persistedExists = await secureWorkspacePathExists(
    workspaceRoot,
    persistedPath,
  );
  const sourcePath = importStagingPath(workspaceRoot, payload.sourceNotePath);
  const sourceExists = await secureWorkspacePathExists(
    workspaceRoot,
    sourcePath,
  );
  if (!persistedExists) {
    if (!sourceExists) {
      throw new Error("Persisted import application has no remaining authority");
    }
    if (previousApplication.finalTemp) {
      const temp = artifactFromReviewRecord(
        workspaceRoot,
        previousApplication.finalTemp,
      );
      if (await secureWorkspacePathExists(workspaceRoot, temp.targetPath)) {
        await secureRemoveWorkspaceArtifact(workspaceRoot, temp, {
          operation: "persisted_final_temp_cleanup",
          hooks: ioHooks,
          unlinkFile: fileOps.unlink,
        });
      }
    }
    return undefined;
  }

  const recordedFinal = previousApplication.final ?? previousApplication.finalTemp;
  if (!recordedFinal) {
    throw new Error("Persisted import destination has no publication identity");
  }
  const expectedFinal = artifactFromReviewRecord(
    workspaceRoot,
    recordedFinal,
    persistedPath,
  );
  let existing;
  try {
    existing = await secureReadWorkspaceArtifact(
      workspaceRoot,
      persistedPath,
      {
        operation: "persisted_destination_reconcile",
        hooks: ioHooks,
        expectedArtifact: expectedFinal,
      },
    );
  } catch {
    throw new Error("Persisted import destination does not match its publication identity");
  }
  if (existing.artifact.sha256 !== previousApplication.expectedFinalHash) {
    throw new Error("Persisted import destination does not match its approved hash");
  }

  try {
    const attachment = await secureReadWorkspaceArtifact(
      workspaceRoot,
      artifactFromReviewRecord(
        workspaceRoot,
        previousApplication.attachment,
      ).targetPath,
      {
        operation: "persisted_attachment_reconcile",
        expectedArtifact: artifactFromReviewRecord(
          workspaceRoot,
          previousApplication.attachment,
        ),
      },
    );
    if (sourceExists) {
      const staging = await secureReadWorkspaceArtifact(
        workspaceRoot,
        sourcePath,
        {
          operation: "staging_retire",
          hooks: ioHooks,
          expectedArtifact: artifactFromReviewRecord(
            workspaceRoot,
            previousApplication.staging,
          ),
        },
      );
      const rebound = await readReviewedImportAttachment(
        workspaceRoot,
        sourcePath,
        staging.contents.toString("utf8"),
      );
      if (
        rebound.artifact.targetPath !== attachment.artifact.targetPath
        || rebound.artifact.sha256 !== attachment.artifact.sha256
        || rebound.artifact.fileDev !== attachment.artifact.fileDev
        || rebound.artifact.fileIno !== attachment.artifact.fileIno
      ) {
        throw new Error("Review attachment binding changed before retirement");
      }
      await secureRemoveWorkspaceArtifact(
        workspaceRoot,
        artifactFromReviewRecord(
          workspaceRoot,
          previousApplication.staging,
        ),
        {
          operation: "persisted_staging_retire",
          hooks: ioHooks,
          claimFence,
          unlinkFile: fileOps.unlink,
        },
      );
    }
  } catch (error) {
    if (previousApplication.final) {
      await secureRemoveWorkspaceArtifact(
        workspaceRoot,
        artifactFromReviewRecord(
          workspaceRoot,
          previousApplication.final,
          persistedPath,
        ),
        {
          operation: "persisted_destination_rollback",
          hooks: ioHooks,
          claimFence,
          unlinkFile: fileOps.unlink,
        },
      );
    }
    if (
      error instanceof Error
      && /staging|attachment/iu.test(error.message)
    ) {
      throw error;
    }
    throw new Error("Review staging or attachment artifact changed before retirement");
  }
  return previousApplication.destination;
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
    expectedFinalHash: hashContents(contents),
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
  if (!previousApplication.final) {
    throw new Error("Existing destination has no persisted publication identity");
  }
  let existing;
  try {
    existing = await secureReadWorkspaceArtifact(
      workspaceRoot,
      targetPath,
      {
        operation: "destination_reconcile",
        hooks: ioHooks,
        expectedArtifact: artifactFromReviewRecord(
          workspaceRoot,
          previousApplication.final,
          targetPath,
        ),
      },
    );
  } catch {
    throw new Error("Existing destination does not match the persisted application");
  }
  if (existing.artifact.sha256 !== prepared.expectedFinalHash) {
    throw new Error("Existing destination does not match the persisted application");
  }
}

function hashContents(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function recordReviewArtifact(
  workspaceRoot: string,
  artifact: SecureWorkspaceArtifactIdentity,
): RecordedReviewArtifact {
  return {
    path: reviewRelativePath(workspaceRoot, artifact.targetPath),
    parentPath: reviewRelativePath(workspaceRoot, artifact.parentPath),
    parentRealPath: artifact.parentRealPath,
    parentDev: artifact.parentDev,
    parentIno: artifact.parentIno,
    dev: artifact.fileDev,
    ino: artifact.fileIno,
    sha256: artifact.sha256,
    size: artifact.size,
  };
}

function artifactFromReviewRecord(
  workspaceRoot: string,
  recorded: RecordedReviewArtifact,
  targetPathOverride?: string,
): SecureWorkspaceArtifactIdentity {
  return {
    targetPath: assertInsideWorkspace(
      workspaceRoot,
      targetPathOverride ?? recorded.path,
    ),
    parentPath: assertInsideWorkspace(workspaceRoot, recorded.parentPath),
    parentRealPath: recorded.parentRealPath,
    parentDev: recorded.parentDev,
    parentIno: recorded.parentIno,
    fileDev: recorded.dev,
    fileIno: recorded.ino,
    sha256: recorded.sha256,
    size: recorded.size,
  };
}

function reviewRelativePath(
  workspaceRoot: string,
  targetPath: string,
): string {
  return path
    .relative(
      path.resolve(workspaceRoot),
      assertInsideWorkspace(workspaceRoot, targetPath),
    )
    .split(path.sep)
    .join("/");
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
    sensitivity: classification.sensitivity,
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
    document.content = replaceMarkdownLinkDestination(
      document.content,
      "Original file",
      nextSourceLink,
    );
  }

  return serializeMarkdownDocument(document);
}

async function rejectImportedSourceNote(
  workspaceRoot: string,
  sourceNotePath: string,
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
): Promise<ImportedSourceNotePayload> {
  const sourcePath = importStagingPath(workspaceRoot, payload.sourceNotePath);
  await assertRealPathInsideWorkspace(workspaceRoot, sourcePath, { mustExist: true });
  const body = await secureReadExisting(workspaceRoot, sourcePath, "staging_read");
  const { frontmatter } = parseMarkdownDocument(body);
  const category = contentCategoryFrom(frontmatter.content_category);
  const evidence = frontmatter.classification_evidence ?? [];
  const sensitivity = frontmatter.sensitivity === "restricted"
    ? "restricted"
    : frontmatter.sensitivity === "private" || frontmatter.sensitivity === "sensitive"
      ? "private"
      : frontmatter.sensitivity === "personal"
        ? "personal"
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

function replaceMarkdownLinkDestination(
  markdown: string,
  label: string,
  destination: string,
): string {
  const marker = `[${label}](`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex < 0) {
    return markdown;
  }

  const destinationStart = markerIndex + marker.length;
  let depth = 1;
  let escaped = false;
  for (let index = destinationStart; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character !== ")") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return `${markdown.slice(0, destinationStart)}${destination}${markdown.slice(index)}`;
    }
  }
  return markdown;
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

async function secureReadExisting(
  workspaceRoot: string,
  targetPath: string,
  operation: string,
  ioHooks?: IpcServices["reviewIoHooks"],
): Promise<string> {
  return (
    await secureReadWorkspaceArtifact(
      workspaceRoot,
      targetPath,
      { operation, hooks: ioHooks },
    )
  ).contents.toString("utf8");
}

async function secureRewriteExisting(
  workspaceRoot: string,
  targetPath: string,
  contents: string,
  operation: string,
  ioHooks?: IpcServices["reviewIoHooks"],
  claimFence?: () => Promise<void>,
): Promise<void> {
  await secureRewriteWorkspaceFile(
    workspaceRoot,
    targetPath,
    contents,
    {
      operation,
      hooks: ioHooks,
      claimFence,
    },
  );
}

const defaultReviewImportFileOps: ReviewImportFileOps = {
  unlink: async (targetPath) => unlink(targetPath),
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

  await withWorkspaceWriteLock(workspaceRoot, async (canonicalRoot) => {
    const rules = await appendRoutingPolicyRule(canonicalRoot, rule);
    await syncAgentsRoutingRules(canonicalRoot, rules);
    await writeRoutingRuleAdr(canonicalRoot, rule);
  });
}

async function appendRoutingPolicyRule(
  workspaceRoot: string,
  rule: UserRoutingRule,
): Promise<UserRoutingRule[]> {
  const policyPath = assertInsideWorkspace(workspaceRoot, ".vault/routing-policy.json");
  const snapshot = await readOptionalWorkspaceArtifact(
    workspaceRoot,
    policyPath,
    "routing_policy_read",
  );
  const existing = snapshot
    ? JSON.parse(snapshot.contents.toString("utf8")) as {
      version?: number;
      rules?: UserRoutingRule[];
    }
    : { version: 1, rules: [] };
  const rules = [...(existing.rules ?? [])];
  if (!rules.some((existingRule) => existingRule.id === rule.id)) {
    rules.push(rule);
  }
  await secureAtomicReplaceWorkspaceFile(
    workspaceRoot,
    policyPath,
    `${JSON.stringify({ version: 1, rules }, null, 2)}\n`,
    {
      operation: "routing_policy_write",
      ...(snapshot === undefined
        ? { requireAbsent: true }
        : { expectedArtifact: snapshot.artifact }),
    },
  );
  return rules;
}

async function syncAgentsRoutingRules(
  workspaceRoot: string,
  rules: UserRoutingRule[],
): Promise<void> {
  const agentsPath = assertInsideWorkspace(workspaceRoot, "AGENTS.md");
  const snapshot = await readOptionalWorkspaceArtifact(
    workspaceRoot,
    agentsPath,
    "routing_agents_read",
  );
  const current = snapshot?.contents.toString("utf8")
    ?? "# Workspace Contract\n";
  const heading = "## User Routing Rules";
  let next = current.includes(heading)
    ? current
    : `${current.trimEnd()}\n\n${heading}\n`;
  for (const rule of rules) {
    const ruleLine = `- ${rule.pattern} -> ${rule.destination}`;
    if (!next.includes(ruleLine)) {
      next = next.replace(heading, `${heading}\n${ruleLine}`);
    }
  }
  if (!next.endsWith("\n")) {
    next += "\n";
  }
  await secureAtomicReplaceWorkspaceFile(
    workspaceRoot,
    agentsPath,
    next,
    {
      operation: "routing_agents_write",
      ...(snapshot === undefined
        ? { requireAbsent: true }
        : { expectedArtifact: snapshot.artifact }),
    },
  );
}

async function readOptionalWorkspaceArtifact(
  workspaceRoot: string,
  targetPath: string,
  operation: string,
) {
  if (!await secureWorkspacePathExists(workspaceRoot, targetPath)) {
    return undefined;
  }
  return secureReadWorkspaceArtifact(workspaceRoot, targetPath, { operation });
}

async function writeRoutingRuleAdr(workspaceRoot: string, rule: UserRoutingRule): Promise<void> {
  const adrPath = assertInsideWorkspace(workspaceRoot, defaultRoutingPolicy.decisionPath(rule.id));
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
  const existing = await readOptionalWorkspaceArtifact(
    workspaceRoot,
    adrPath,
    "routing_adr_read",
  );
  if (existing) {
    const existingBody = existing.contents.toString("utf8");
    if (!existingBody.includes(`The source Review item is \`${rule.sourceReviewItemId}\`.`)) {
      throw new Error("Saved routing rule ADR conflicts with an existing file");
    }
    return;
  }
  await securePublishWorkspaceFileAtomic(workspaceRoot, adrPath, contents, {
    operation: "routing_adr_create",
  });
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
  services.workspaceRoot = await realpath(path.resolve(rootPath));
  await syncWorkspaceContract(services.workspaceRoot);
  await recoverImportPromotions(services.workspaceRoot);
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
