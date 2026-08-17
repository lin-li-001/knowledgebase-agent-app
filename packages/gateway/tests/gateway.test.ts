import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppDatabase } from "@kb-agent/storage";
import type { RecallProvider } from "@kb-agent/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KnowledgeBaseGateway, startKnowledgeBaseGateway, startKnowledgeBaseMcpServer } from "../src/index";

interface TestNote {
  id: string;
  title: string;
  path: string;
  status: string;
  sensitivity: string;
  category: string;
  summary: string;
}

describe("KnowledgeBaseGateway", () => {
  it("returns only eligible evidence and fetches notes by id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kb-gateway-"));
    const notePath = path.join(root, "03-Knowledge", "Answer.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(notePath, "# Answer\n\nThe source answer.");
    const db = fakeDatabase([
      { id: "eligible", title: "Answer", path: "03-Knowledge/Answer.md", status: "active", sensitivity: "normal", category: "resource", summary: "A summary" },
      { id: "blocked", title: "Blocked", path: "03-Knowledge/Blocked.md", status: "pending_review", sensitivity: "normal", category: "resource", summary: "Hidden" },
    ]);
    const provider: RecallProvider = {
      name: "test",
      async prefetch() {
        return [
          { provider: "test", sourceType: "note", title: "Answer", path: "03-Knowledge/Answer.md", text: "The source answer.", noteId: "eligible" },
          { provider: "test", sourceType: "note", title: "Blocked", path: "03-Knowledge/Blocked.md", text: "Hidden", noteId: "blocked" },
        ];
      },
    };
    const gateway = new KnowledgeBaseGateway({ db, workspaceId: "workspace", workspaceRoot: root, recallProvider: provider });

    await expect(gateway.search({ query: "answer" })).resolves.toEqual([
      expect.objectContaining({ noteId: "eligible", text: "The source answer." }),
    ]);
    await expect(gateway.fetchNote("eligible")).resolves.toEqual(expect.objectContaining({ content: "# Answer\n\nThe source answer." }));
    await expect(gateway.fetchNote("blocked")).resolves.toBeUndefined();
  });

  it("requires bearer auth for HTTP routes", async () => {
    const db = fakeDatabase([]);
    const provider: RecallProvider = { name: "test", async prefetch() { return []; } };
    const gateway = new KnowledgeBaseGateway({ db, workspaceId: "workspace", workspaceRoot: "/tmp", recallProvider: provider });
    const running = await startKnowledgeBaseGateway({ gateway, token: "secret" });
    const unauthorized = await fetch(`http://${running.host}:${running.port}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`http://${running.host}:${running.port}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ query: "test" }),
    });
    expect(authorized.status).toBe(200);
    await running.close();
  });

  it("creates a local Review proposal without writing a note", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kb-gateway-proposal-"));
    const db = fakeDatabase([]);
    const provider: RecallProvider = { name: "test", async prefetch() { return []; } };
    const gateway = new KnowledgeBaseGateway({ db, workspaceId: "workspace", workspaceRoot: root, recallProvider: provider });

    const proposal = await gateway.proposeCreateNote({
      path: "00-Inbox/Proposed.md",
      body: "# Proposed\n\nDraft content.",
      sourceContext: {
        conversationSummary: "The user asked to preserve this draft.",
        userIntent: "save_to_knowledge_base",
        keyFacts: ["The draft should be reviewed before writing."],
      },
    });

    expect(proposal).toEqual(expect.objectContaining({
      state: "proposed",
      proposalType: "propose_create_note",
      targetPath: "00-Inbox/Proposed.md",
    }));
    await expect(import("node:fs/promises").then(({ access }) => access(path.join(root, "00-Inbox/Proposed.md")))).rejects.toThrow();
  });

  it("exposes the governed MCP tool contract over Streamable HTTP", async () => {
    const db = fakeDatabase([]);
    const provider: RecallProvider = { name: "test", async prefetch() { return []; } };
    const gateway = new KnowledgeBaseGateway({ db, workspaceId: "workspace", workspaceRoot: "/tmp", recallProvider: provider });
    const running = await startKnowledgeBaseMcpServer({ gateway, token: "secret" });
    const client = new Client({ name: "gateway-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${running.host}:${running.port}/mcp`),
      { requestInit: { headers: { authorization: "Bearer secret" } } },
    );

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "kb_search",
      "kb_fetch_note",
      "kb_propose_create_note",
    ]);
    await client.close();
    await running.close();
  });

  it("can explicitly allow unauthenticated MCP traffic for a loopback tunnel", async () => {
    const db = fakeDatabase([]);
    const provider: RecallProvider = { name: "test", async prefetch() { return []; } };
    const gateway = new KnowledgeBaseGateway({ db, workspaceId: "workspace", workspaceRoot: "/tmp", recallProvider: provider });
    const running = await startKnowledgeBaseMcpServer({ gateway, token: "secret", allowUnauthenticated: true });
    const client = new Client({ name: "gateway-no-auth-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://${running.host}:${running.port}/mcp`));

    await client.connect(transport);
    await expect(client.listTools()).resolves.toEqual(expect.objectContaining({ tools: expect.any(Array) }));
    await client.close();
    await running.close();
  });
});

function fakeDatabase(notes: TestNote[]): AppDatabase {
  const reviewItems: unknown[] = [];
  return {
    sqlite: {
      prepare(sql: string) {
        if (sql.includes("INSERT INTO review_items")) {
          return { run(item: unknown) { reviewItems.push(item); } };
        }
        return {
          get(noteId: string, workspaceId: string) {
            return workspaceId === "workspace" ? notes.find((note) => note.id === noteId) : undefined;
          },
        };
      },
    },
    close() {},
  } as unknown as AppDatabase;
}
