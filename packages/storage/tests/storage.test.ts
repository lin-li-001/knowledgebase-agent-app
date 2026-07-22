import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendMessage,
  latestMigrationVersion,
  openAppDatabase,
  searchNotes,
  searchSessions,
  type AppDatabase,
} from "../src/index";

let opened: AppDatabase[] = [];

afterEach(() => {
  for (const db of opened) {
    db.close();
  }
  opened = [];
});

async function openTempDb(): Promise<AppDatabase> {
  const dir = await mkdtemp(path.join(tmpdir(), "kb-agent-db-"));
  const db = openAppDatabase(path.join(dir, "index.sqlite"));
  opened.push(db);
  return db;
}

describe("migrations", () => {
  it("creates schema, FTS tables, foreign keys, and migration version", async () => {
    const db = await openTempDb();

    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "workspaces",
        "notes",
        "chunks",
        "sessions",
        "messages",
        "review_items",
        "activity_events",
        "import_jobs",
        "note_fts",
        "note_fts_trigram",
        "message_fts",
        "message_fts_trigram",
      ]),
    );
    expect(db.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.sqlite.pragma("user_version", { simple: true })).toBe(latestMigrationVersion);
  });

  it("cascades workspace-owned runtime records", async () => {
    const db = await openTempDb();
    const now = new Date().toISOString();

    db.sqlite
      .prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("workspace-1", "/tmp/workspace-1", now, now);
    db.sqlite
      .prepare(
        `INSERT INTO notes (
          id, workspace_id, path, title, type, status, owner, scope, sensitivity,
          tags_json, summary_source, content_hash, modified_at, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "note-1",
        "workspace-1",
        "03-Knowledge/Memory.md",
        "Memory",
        "knowledge",
        "active",
        "default",
        "personal",
        "normal",
        "[]",
        "heuristic",
        "hash",
        now,
        now,
      );
    db.sqlite
      .prepare("INSERT INTO sessions (id, workspace_id, profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("session-1", "workspace-1", "default", "Chat", now, now);
    db.sqlite
      .prepare(
        `INSERT INTO review_items (
          id, workspace_id, state, risk, proposal_type, payload_json, reason,
          source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("review-1", "workspace-1", "proposed", "high", "memory", "{}", "reason", "session-1", "turn-1", now);
    db.sqlite
      .prepare("INSERT INTO activity_events (id, workspace_id, kind, title, message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("activity-1", "workspace-1", "workspace", "Created", "Created workspace", now);
    db.sqlite
      .prepare(
        `INSERT INTO import_jobs (
          id, workspace_id, batch_name, state, attachment_dir, summary_note_path,
          source_files_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("import-1", "workspace-1", "Batch", "pending", "attachments", "summary.md", "[]", now);

    db.sqlite.prepare("DELETE FROM workspaces WHERE id = ?").run("workspace-1");

    for (const table of ["notes", "sessions", "review_items", "activity_events", "import_jobs"]) {
      expect(db.sqlite.prepare(`SELECT COUNT(*) as count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });
});

describe("search", () => {
  it("finds English and Chinese notes and sessions", async () => {
    const db = await openTempDb();
    const now = new Date().toISOString();

    db.sqlite
      .prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("workspace-1", "/tmp/workspace-1", now, now);
    db.sqlite
      .prepare("INSERT INTO sessions (id, workspace_id, profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("session-1", "workspace-1", "default", "Chat", now, now);

    insertSearchableNote(db, {
      id: "note-english",
      workspaceId: "workspace-1",
      path: "03-Knowledge/Graph Memory.md",
      title: "Graph Memory",
      body: "Graph memory architecture",
      now,
    });
    insertSearchableNote(db, {
      id: "note-chinese",
      workspaceId: "workspace-1",
      path: "03-Knowledge/中文搜索.md",
      title: "中文搜索",
      body: "中文 搜索 测试",
      now,
    });

    await appendMessage(db, {
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      content: "中文 session 内容",
      createdAt: now,
    });

    await expect(searchNotes(db, "memory", { workspaceId: "workspace-1" })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ noteId: "note-english" })]),
    );
    await expect(
      searchNotes(db, "hello my name is lin li, i have two kids (grace and leo)", { workspaceId: "workspace-1" }),
    ).resolves.toEqual([]);
    await expect(searchNotes(db, "中文", { workspaceId: "workspace-1" })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ noteId: "note-chinese" })]),
    );
    await expect(searchSessions(db, "hello, world", { workspaceId: "workspace-1" })).resolves.toEqual([]);
    await expect(searchSessions(db, "中文", { workspaceId: "workspace-1" })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ messageId: "message-1" })]),
    );
  });

  it("recalls notes for natural-language questions without requiring every query word", async () => {
    const db = await openTempDb();
    const now = new Date().toISOString();

    db.sqlite
      .prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("workspace-1", "/tmp/workspace-1", now, now);

    insertSearchableNote(db, {
      id: "note-resume",
      workspaceId: "workspace-1",
      path: "04-Resources/Imports/resume.md",
      title: "resume",
      body: "EXPERIENCE\nLQ Digital, San Francisco, CA | Jun 2017 - Mar 2019",
      now,
    });

    await expect(searchNotes(db, "where did I work in 2018", { workspaceId: "workspace-1" })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ noteId: "note-resume" })]),
    );
  });
});

function insertSearchableNote(
  db: AppDatabase,
  input: {
    id: string;
    workspaceId: string;
    path: string;
    title: string;
    body: string;
    now: string;
  },
): void {
  db.sqlite
    .prepare(
      `INSERT INTO notes (
        id, workspace_id, path, title, type, status, owner, scope, sensitivity,
        tags_json, summary, summary_source, content_hash, modified_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.workspaceId,
      input.path,
      input.title,
      "knowledge",
      "active",
      "default",
      "personal",
      "normal",
      "[]",
      input.body,
      "heuristic",
      input.id,
      input.now,
      input.now,
    );
  db.sqlite
    .prepare("INSERT INTO note_fts (note_id, workspace_id, title, summary, headings, body, path) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(input.id, input.workspaceId, input.title, input.body, "", input.body, input.path);
  db.sqlite
    .prepare("INSERT INTO note_fts_trigram (note_id, workspace_id, title, summary, headings, body, path) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(input.id, input.workspaceId, input.title, input.body, "", input.body, input.path);
}
