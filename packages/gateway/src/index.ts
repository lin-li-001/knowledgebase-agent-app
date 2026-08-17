import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { EvidenceBundle, RecallProvider } from "@kb-agent/core";
import { createReviewItem, type AppDatabase, type ReviewItem } from "@kb-agent/storage";
import { assertInsideWorkspace } from "@kb-agent/workspace";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  limit: z.number().int().min(1).max(20).optional(),
});

const fetchNoteRequestSchema = z.object({
  noteId: z.string().trim().min(1).max(200),
});

const createNoteProposalSchema = z.object({
  path: z.string().trim().min(1).max(1000),
  body: z.string().min(1).max(100_000),
  reason: z.string().trim().min(1).max(1000).optional(),
  sourceContext: z.object({
    conversationSummary: z.string().trim().min(1).max(12_000),
    userIntent: z.literal("save_to_knowledge_base"),
    keyFacts: z.array(z.string().trim().min(1).max(1000)).max(50),
  }),
});

const acceptedStatuses = new Set(["active", "auto_written", "approved"]);
const allowedSensitivities = new Set(["normal", "personal"]);
const gatewaySearchResultSchema = z.object({
  noteId: z.string(),
  title: z.string(),
  path: z.string(),
  text: z.string(),
  score: z.number().optional(),
  snippet: z.string().optional(),
  chunkId: z.string().optional(),
  headingPath: z.array(z.string()).optional(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
});

export interface KnowledgeBaseGatewayOptions {
  db: AppDatabase;
  workspaceId: string;
  workspaceRoot: string;
  recallProvider: RecallProvider;
  maxResults?: number;
  onAuditEvent?(event: GatewayAuditEvent): Promise<void> | void;
}

export interface GatewayAuditEvent {
  operation: "search" | "fetch_note" | "propose_create_note";
  workspaceId: string;
  queryLength?: number;
  noteId?: string;
  resultCount?: number;
  reviewItemId?: string;
  outcome: "success" | "not_found" | "error";
  createdAt: string;
}

export interface GatewaySearchRequest {
  query: string;
  limit?: number;
}

export interface GatewaySearchResult {
  noteId: string;
  title: string;
  path: string;
  text: string;
  score?: number;
  snippet?: string;
  chunkId?: string;
  headingPath?: string[];
  startLine?: number;
  endLine?: number;
}

export interface GatewayNote {
  noteId: string;
  title: string;
  path: string;
  status: string;
  sensitivity: string;
  category: string;
  summary?: string;
  content: string;
}

export interface GatewayProposal {
  reviewItemId: string;
  state: "proposed";
  proposalType: "propose_create_note";
  targetPath: string;
}

interface NoteRow {
  id: string;
  title: string;
  path: string;
  status: string;
  sensitivity: string;
  category: string;
  summary?: string;
}

export class KnowledgeBaseGateway {
  private readonly maxResults: number;

  constructor(private readonly options: KnowledgeBaseGatewayOptions) {
    this.maxResults = options.maxResults ?? 8;
  }

  async search(input: GatewaySearchRequest): Promise<GatewaySearchResult[]> {
    const parsed = searchRequestSchema.parse(input);
    try {
      const evidence = await this.options.recallProvider.prefetch({
        db: this.options.db,
        workspaceId: this.options.workspaceId,
        workspaceRoot: this.options.workspaceRoot,
        query: parsed.query,
      });
      const results: GatewaySearchResult[] = [];
      const seen = new Set<string>();
      for (const item of evidence) {
        if (!item.noteId) continue;
        const note = this.readAllowedNote(item.noteId);
        if (!note) continue;
        const key = item.chunkId ? `chunk:${item.chunkId}` : `note:${note.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          noteId: note.id,
          title: note.title,
          path: note.path,
          text: item.text,
          ...(item.score === undefined ? {} : { score: item.score }),
          ...(item.snippet === undefined ? {} : { snippet: item.snippet }),
          ...(item.chunkId === undefined ? {} : { chunkId: item.chunkId }),
          ...(item.headingPath === undefined ? {} : { headingPath: item.headingPath }),
          ...(item.startLine === undefined ? {} : { startLine: item.startLine }),
          ...(item.endLine === undefined ? {} : { endLine: item.endLine }),
        });
        if (results.length >= Math.min(parsed.limit ?? this.maxResults, this.maxResults)) break;
      }
      await this.audit({ operation: "search", queryLength: parsed.query.length, resultCount: results.length, outcome: "success" });
      return results;
    } catch (error) {
      await this.audit({ operation: "search", queryLength: parsed.query.length, outcome: "error" });
      throw error;
    }
  }

  async fetchNote(noteId: string): Promise<GatewayNote | undefined> {
    const parsed = fetchNoteRequestSchema.parse({ noteId });
    const note = this.readAllowedNote(parsed.noteId);
    if (!note) {
      await this.audit({ operation: "fetch_note", noteId: parsed.noteId, outcome: "not_found" });
      return undefined;
    }
    const absolutePath = assertInsideWorkspace(this.options.workspaceRoot, note.path);
    const result = {
      noteId: note.id,
      title: note.title,
      path: note.path,
      status: note.status,
      sensitivity: note.sensitivity,
      category: note.category,
      ...(note.summary === undefined ? {} : { summary: note.summary }),
      content: await readFile(absolutePath, "utf8"),
    };
    await this.audit({ operation: "fetch_note", noteId: parsed.noteId, outcome: "success" });
    return result;
  }

  async proposeCreateNote(input: {
    path: string;
    body: string;
    reason?: string;
    sourceContext: {
      conversationSummary: string;
      userIntent: "save_to_knowledge_base";
      keyFacts: string[];
    };
  }): Promise<GatewayProposal> {
    const parsed = createNoteProposalSchema.parse(input);
    const targetPath = parsed.path.replaceAll("\\", "/");
    assertInsideWorkspace(this.options.workspaceRoot, targetPath);
    const now = new Date().toISOString();
    const reviewItemId = randomUUID();
    const reason = parsed.reason ?? "ChatGPT proposed a knowledge-base note; local Review approval is required.";
    const item: ReviewItem = {
      id: reviewItemId,
      workspaceId: this.options.workspaceId,
      state: "proposed",
      risk: "medium",
      proposalType: "propose_create_note",
      targetPath,
      payload: {
        path: targetPath,
        body: parsed.body,
        source: {
          origin: "chatgpt_mcp",
          reason,
          conversationSummary: parsed.sourceContext.conversationSummary,
          userIntent: parsed.sourceContext.userIntent,
          keyFacts: parsed.sourceContext.keyFacts,
        },
      },
      reason,
      sourceSessionId: "chatgpt-mcp",
      sourceTurnId: randomUUID(),
      createdAt: now,
    };
    await createReviewItem(this.options.db, item);
    await this.audit({ operation: "propose_create_note", reviewItemId, outcome: "success" });
    return { reviewItemId, state: "proposed", proposalType: "propose_create_note", targetPath };
  }

  private async audit(event: Omit<GatewayAuditEvent, "workspaceId" | "createdAt">): Promise<void> {
    await this.options.onAuditEvent?.({
      ...event,
      workspaceId: this.options.workspaceId,
      createdAt: new Date().toISOString(),
    });
  }

  private readAllowedNote(noteId: string): NoteRow | undefined {
    const row = this.options.db.sqlite.prepare(
      `SELECT id, title, path, status, sensitivity, content_category as category, summary
       FROM notes
       WHERE id = ? AND workspace_id = ?`,
    ).get(noteId, this.options.workspaceId) as NoteRow | undefined;
    if (!row || !acceptedStatuses.has(row.status) || !allowedSensitivities.has(row.sensitivity)) {
      return undefined;
    }
    return row;
  }
}

export interface GatewayServerOptions {
  gateway: KnowledgeBaseGateway;
  token: string;
  host?: string;
  port?: number;
  allowUnauthenticated?: boolean;
}

export interface RunningGatewayServer {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface RunningKnowledgeBaseMcpServer {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

export function createKnowledgeBaseMcpServer(gateway: KnowledgeBaseGateway): McpServer {
  const server = new McpServer(
    { name: "knowledge-base", version: "0.1.0" },
    {
      instructions: "Search the user's governed knowledge base. Use returned source paths and line locations when answering. Do not infer facts not present in tool results.",
    },
  );
  server.registerTool(
    "kb_search",
    {
      title: "Search Knowledge Base",
      description: "Search accepted, externally-eligible notes and source chunks using hybrid lexical and semantic retrieval.",
      inputSchema: {
        query: z.string().trim().min(1).max(4000),
        limit: z.number().int().min(1).max(20).optional(),
      },
      outputSchema: { results: z.array(gatewaySearchResultSchema) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const request: GatewaySearchRequest = input.limit === undefined
        ? { query: input.query }
        : { query: input.query, limit: input.limit };
      const results = await gateway.search(request);
      return {
        structuredContent: { results },
        content: [{ type: "text", text: `Found ${results.length} eligible knowledge results.` }],
      };
    },
  );
  server.registerTool(
    "kb_fetch_note",
    {
      title: "Fetch Knowledge Base Note",
      description: "Fetch one accepted note by its noteId after the gateway's workspace and sensitivity checks.",
      inputSchema: {
        noteId: z.string().trim().min(1).max(200),
      },
      outputSchema: {
        noteId: z.string(),
        title: z.string(),
        path: z.string(),
        status: z.string(),
        sensitivity: z.string(),
        category: z.string(),
        summary: z.string().optional(),
        content: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ noteId }) => {
      const note = await gateway.fetchNote(noteId);
      if (!note) {
        throw new Error("Note not found or not eligible for external context");
      }
      return {
        structuredContent: { ...note },
        content: [{ type: "text", text: `Fetched ${note.title}.` }],
      };
    },
  );
  server.registerTool(
    "kb_propose_create_note",
    {
      title: "Propose Knowledge Base Note",
      description: "Create a local Review proposal for a new Markdown note. This never writes the note directly.",
      inputSchema: {
        path: z.string().trim().min(1).max(1000),
        body: z.string().min(1).max(100_000),
        reason: z.string().trim().min(1).max(1000).optional(),
        sourceContext: z.object({
          conversationSummary: z.string().trim().min(1).max(12_000),
          userIntent: z.literal("save_to_knowledge_base"),
          keyFacts: z.array(z.string().trim().min(1).max(1000)).max(50),
        }),
      },
      outputSchema: {
        reviewItemId: z.string(),
        state: z.literal("proposed"),
        proposalType: z.literal("propose_create_note"),
        targetPath: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const proposal = await gateway.proposeCreateNote(
        input.reason === undefined
          ? { path: input.path, body: input.body, sourceContext: input.sourceContext }
          : { path: input.path, body: input.body, reason: input.reason, sourceContext: input.sourceContext },
      );
      return {
        structuredContent: { ...proposal },
        content: [{ type: "text", text: `Created Review proposal ${proposal.reviewItemId}; no note was written.` }],
      };
    },
  );
  return server;
}

export async function startKnowledgeBaseMcpServer(options: GatewayServerOptions): Promise<RunningKnowledgeBaseMcpServer> {
  if (!options.token.trim()) {
    throw new Error("Knowledge Base MCP Server requires a non-empty bearer token");
  }
  const host = options.host ?? "127.0.0.1";
  const httpServer = createServer((request, response) => {
    void handleMcpRequest(options.gateway, options.token, options.allowUnauthenticated === true, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(options.port ?? 0, host);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeServer(httpServer);
    throw new Error("Knowledge Base MCP Server did not expose a TCP address");
  }
  return {
    server: httpServer,
    host,
    port: address.port,
    close: () => closeServer(httpServer),
  };
}

async function handleMcpRequest(
  gateway: KnowledgeBaseGateway,
  token: string,
  allowUnauthenticated: boolean,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.url !== "/mcp") {
    writeJson(response, 404, { error: "Not found" });
    return;
  }
  if (!allowUnauthenticated && !authorized(request, token)) {
    writeJson(response, 401, { error: "Unauthorized" });
    return;
  }
  const mcpServer = createKnowledgeBaseMcpServer(gateway);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
  try {
    await mcpServer.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
    await transport.handleRequest(request, response);
  } catch (error) {
    if (!response.headersSent) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : "MCP request failed" });
    }
  } finally {
    await mcpServer.close().catch(() => undefined);
  }
}

export async function startKnowledgeBaseGateway(options: GatewayServerOptions): Promise<RunningGatewayServer> {
  if (!options.token.trim()) {
    throw new Error("Knowledge Base Gateway requires a non-empty bearer token");
  }
  const host = options.host ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void handleRequest(options.gateway, options.token, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, host);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Knowledge Base Gateway did not expose a TCP address");
  }
  return {
    server,
    host,
    port: address.port,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  gateway: KnowledgeBaseGateway,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (!authorized(request, token)) {
      writeJson(response, 401, { error: "Unauthorized" });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/search") {
      const input = searchRequestSchema.parse(JSON.parse(await readBody(request)));
      const requestInput: GatewaySearchRequest = input.limit === undefined
        ? { query: input.query }
        : { query: input.query, limit: input.limit };
      writeJson(response, 200, { results: await gateway.search(requestInput) });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/notes/fetch") {
      const input = fetchNoteRequestSchema.parse(JSON.parse(await readBody(request)));
      const note = await gateway.fetchNote(input.noteId);
      if (!note) {
        writeJson(response, 404, { error: "Note not found or not eligible for external context" });
        return;
      }
      writeJson(response, 200, note);
      return;
    }
    writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    const status = error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
    writeJson(response, status, { error: error instanceof Error ? error.message : "Gateway request failed" });
  }
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const value = request.headers.authorization;
  const prefix = "Bearer ";
  if (!value?.startsWith(prefix)) return false;
  const supplied = Buffer.from(value.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
