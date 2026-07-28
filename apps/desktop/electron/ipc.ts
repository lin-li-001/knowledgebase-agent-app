import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createReviewItem, getReviewItem, getReviewItemState, listActivity, listReviewItems, openAppDatabase, recordActivity, searchNotes, searchSessions, transitionReviewItem, type ActivityEvent, type AppDatabase, type ReviewItem, type ReviewState } from "@kb-agent/storage";
import { MockProvider, OpenAIProvider, type ModelProvider } from "@kb-agent/model";
import { runTurn, startImportBatch, type ToolHandler, type MvpToolName } from "@kb-agent/core";
import { assertInsideWorkspace, auditWorkspace, createWorkspace, defaultRoutingPolicy, indexWorkspace, syncWorkspaceContract, workspaceIdForRoot } from "@kb-agent/workspace";
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
          saveAsRoutingRule: payload.saveAsRoutingRule === true,
          routingRulePattern: typeof payload.routingRulePattern === "string" ? payload.routingRulePattern : undefined,
        });
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
  saveAsRoutingRule?: boolean | undefined;
  routingRulePattern?: string | undefined;
}

async function approveReviewItem(services: IpcServices, id: string, options: ReviewApproveOptions = {}): Promise<IpcResult> {
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

  if (item.proposalType === "propose_create_note" || item.proposalType === "propose_decision") {
    if (item.state === "proposed") {
      await transitionReviewItem(db, id, "proposed", "approved");
    }

    let entityPath: string;
    try {
      entityPath = await applyKnowledgeProposal(services, item, options);
    } catch (error) {
      if (isImportedSourceNotePayload(item.payload)) {
        await transitionReviewItem(db, id, "approved", "failed", {
          failureReason: error instanceof Error ? error.message : "Failed to move imported source note",
        });
      }
      throw error;
    }
    const appliedAt = new Date().toISOString();
    await transitionReviewItem(db, id, "approved", "applied", { appliedAt });
    await recordActivity(db, {
      id: randomUUID(),
      workspaceId: item.workspaceId,
      kind: "review",
      title: item.proposalType === "propose_decision" ? "Decision saved" : "Note created",
      message: `Approved ${item.proposalType} proposal was saved.`,
      entityPath,
      reviewItemId: id,
      createdAt: appliedAt,
    });
    if (options.saveAsRoutingRule && options.targetPathOverride?.trim()) {
      await saveUserRoutingRule(services, item, {
        destination: options.targetPathOverride.trim(),
        pattern: options.routingRulePattern?.trim() || routingPatternFor(item),
        createdAt: appliedAt,
      });
    }
    if (item.proposalType === "propose_create_note") {
      await indexWorkspace(requireWorkspaceRoot(services), db);
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
    entityPath: defaultRoutingPolicy.profileMemoryPath(await getActiveProfileId(services)),
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

async function applyKnowledgeProposal(services: IpcServices, item: ReviewItem, options: ReviewApproveOptions = {}): Promise<string> {
  if (item.proposalType === "propose_create_note") {
    if (isImportedSourceNotePayload(item.payload)) {
      const destination = options.targetPathOverride?.trim() || item.payload.destination;
      return moveImportedSourceNote(requireWorkspaceRoot(services), item.payload.sourceNotePath, destination);
    }
    const payload = createNotePayload(item.payload);
    const relativePath = options.targetPathOverride?.trim() || payload.path;
    const targetPath = assertInsideWorkspace(requireWorkspaceRoot(services), relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, payload.body, { encoding: "utf8", flag: "wx" });
    return relativePath;
  }

  if (item.proposalType === "propose_decision") {
    const body = extractDecisionBody(item.payload);
    const relativePath = options.targetPathOverride?.trim() || item.targetPath || defaultRoutingPolicy.decisionPath(item.id);
    const targetPath = assertInsideWorkspace(requireWorkspaceRoot(services), relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${body.trimEnd()}\n`, { encoding: "utf8", flag: "wx" });
    return relativePath;
  }

  throw new Error(`Unsupported proposal apply: ${item.proposalType}`);
}

interface ImportedSourceNotePayload {
  sourceNotePath: string;
  destination: string;
}

function isImportedSourceNotePayload(payload: unknown): payload is ImportedSourceNotePayload {
  return typeof payload === "object"
    && payload !== null
    && typeof (payload as Record<string, unknown>).sourceNotePath === "string"
    && typeof (payload as Record<string, unknown>).destination === "string";
}

async function moveImportedSourceNote(workspaceRoot: string, sourceNotePath: string, destination: string): Promise<string> {
  const sourcePath = assertInsideWorkspace(workspaceRoot, sourceNotePath);
  const destinationPath = assertInsideWorkspace(workspaceRoot, destination);
  const body = await readFile(sourcePath, "utf8");
  const updatedBody = updateImportedSourceNoteRoute(body, sourcePath, destinationPath, destination);

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, updatedBody, { encoding: "utf8", flag: "wx" });
  await unlink(sourcePath);
  return destination;
}

function updateImportedSourceNoteRoute(body: string, sourcePath: string, destinationPath: string, destination: string): string {
  const currentSourceLink = yamlField(body, "source_file");
  const nextSourceLink = currentSourceLink
    ? path.relative(path.dirname(destinationPath), path.resolve(path.dirname(sourcePath), currentSourceLink)).split(path.sep).join("/")
    : undefined;
  let updated = body
    .replace(/^status: .+$/mu, "status: active")
    .replace(/^tags: \[imported, pending-review\]$/mu, "tags: [imported, approved]")
    .replace(/^route_status: .+$/mu, "route_status: approved")
    .replace(/^route_destination: .+$/mu, `route_destination: ${destination}`)
    .replace(/^- Status: .+$/mu, "- Status: approved")
    .replace(/^- Destination: .+$/mu, `- Destination: ${destination}`);

  if (nextSourceLink) {
    updated = updated
      .replace(/^source_file: .+$/mu, `source_file: ${nextSourceLink}`)
      .replace(/(- \[Original file\]\()[^)]+(\))/u, `$1${nextSourceLink}$2`);
  }

  return updated;
}

function yamlField(body: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "mu").exec(body);
  return match?.[1]?.trim().replace(/^(["'])(.*)\1$/u, "$2");
}

interface UserRoutingRule {
  id: string;
  pattern: string;
  destination: string;
  sourceReviewItemId: string;
  createdAt: string;
}

async function saveUserRoutingRule(
  services: IpcServices,
  item: ReviewItem,
  input: { pattern: string; destination: string; createdAt: string },
): Promise<void> {
  const workspaceRoot = requireWorkspaceRoot(services);
  const rule: UserRoutingRule = {
    id: `routing-rule-${item.id}`,
    pattern: input.pattern,
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
  await writeFile(
    adrPath,
    `# User-defined routing rule

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
`,
    { encoding: "utf8", flag: "wx" },
  );
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
