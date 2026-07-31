import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendMessage,
  claimReviewItem,
  createReviewItem,
  expireReviewItemClaims,
  getReviewItem,
  latestMigrationVersion,
  openAppDatabase,
  renewReviewItemClaim,
  searchNotes,
  searchSessions,
  transitionClaimedReviewItem,
  type AppDatabase,
  type ReviewItem,
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
    const reviewColumns = db.sqlite
      .prepare("PRAGMA table_info(review_items)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(reviewColumns).toEqual(expect.arrayContaining(["claim_token", "claim_started_at", "application_json"]));
  });

  it("keeps checked-in schema.sql synchronized with Review claim columns", async () => {
    const schemaFile = await readFile(new URL("../src/schema.sql", import.meta.url), "utf8");
    expect(schemaFile).toContain("claim_token TEXT");
    expect(schemaFile).toContain("claim_started_at TEXT");
    expect(schemaFile).toContain("application_json TEXT");
  });

  it("migrates a version 1 Review table to durable claim storage", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kb-agent-db-v1-"));
    const dbPath = path.join(dir, "index.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE review_items (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        state TEXT NOT NULL,
        risk TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        target_path TEXT,
        payload_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        superseded_by TEXT,
        failure_reason TEXT
      );
    `);
    legacy.pragma("user_version = 1");
    legacy.close();

    const migrated = openAppDatabase(dbPath);
    opened.push(migrated);
    const columns = migrated.sqlite
      .prepare("PRAGMA table_info(review_items)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual(expect.arrayContaining(["claim_token", "claim_started_at", "application_json"]));
    expect(migrated.sqlite.pragma("user_version", { simple: true })).toBe(3);
    expect(migrated.sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('note_embeddings', 'chunk_embeddings')").all()).toHaveLength(2);
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

describe("Review item claims", () => {
  it("normalizes expired applying and rejecting leases into retryable failures", async () => {
    const db = await openTempDb();
    const applying = await insertClaimableReview(db, "review-expired-applying");
    const rejecting = await insertClaimableReview(db, "review-expired-rejecting");
    await claimReviewItem(db, applying.id, {
      from: ["proposed"],
      to: "applying",
      token: "old-applying",
      startedAt: "2000-01-01T00:00:00.000Z",
      application: { destination: "04-Resources/A.md" },
    });
    await claimReviewItem(db, rejecting.id, {
      from: ["proposed"],
      to: "rejecting",
      token: "old-rejecting",
      startedAt: "2000-01-01T00:00:00.000Z",
    });

    await expect(expireReviewItemClaims(
      db,
      applying.workspaceId,
      "2026-07-29T00:00:00.000Z",
    )).resolves.toBe(1);
    await expect(expireReviewItemClaims(
      db,
      rejecting.workspaceId,
      "2026-07-29T00:00:00.000Z",
    )).resolves.toBe(1);
    await expect(getReviewItem(db, applying.id)).resolves.toEqual(
      expect.objectContaining({
        state: "failed",
        failureReason: "Previous applying lease expired; retry is available.",
        application: { destination: "04-Resources/A.md" },
      }),
    );
    await expect(getReviewItem(db, rejecting.id)).resolves.toEqual(
      expect.objectContaining({
        state: "failed",
        failureReason: "Previous rejecting lease expired; retry is available.",
      }),
    );
  });

  it("allows only one durable application claimant", async () => {
    const db = await openTempDb();
    const now = new Date().toISOString();
    db.sqlite
      .prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("workspace-claim", "/tmp/workspace-claim", now, now);
    const item: ReviewItem = {
      id: "review-claim",
      workspaceId: "workspace-claim",
      state: "proposed",
      risk: "high",
      proposalType: "propose_create_note",
      payload: { path: "Note.md", body: "body" },
      reason: "test",
      sourceSessionId: "session-claim",
      sourceTurnId: "turn-claim",
      createdAt: now,
    };
    await createReviewItem(db, item);

    await expect(claimReviewItem(db, item.id, {
      from: ["proposed", "failed"],
      to: "applying",
      token: "claim-1",
      startedAt: now,
      application: { destination: "Note.md" },
    })).resolves.toBe(true);
    await expect(claimReviewItem(db, item.id, {
      from: ["proposed", "failed"],
      to: "applying",
      token: "claim-2",
      startedAt: now,
    })).resolves.toBe(false);
    await expect(getReviewItem(db, item.id)).resolves.toEqual(
      expect.objectContaining({
        state: "applying",
        claimToken: "claim-1",
        application: { destination: "Note.md" },
      }),
    );
  });

  it("never lets a persisted application intent be claimed for rejection", async () => {
    const db = await openTempDb();
    const item = await insertClaimableReview(db, "review-prepared-reject");
    await claimReviewItem(db, item.id, {
      from: ["proposed"],
      to: "applying",
      token: "preparing-worker",
      startedAt: "2000-01-01T00:00:00.000Z",
      application: {
        kind: "import_move",
        destination: "04-Resources/Approved/A.md",
      },
    });
    await expireReviewItemClaims(
      db,
      item.workspaceId,
      "2026-07-29T00:00:00.000Z",
    );

    await expect(claimReviewItem(db, item.id, {
      from: ["failed"],
      to: "rejecting",
      token: "rejecting-worker",
      startedAt: "2026-07-29T00:00:00.000Z",
    })).resolves.toBe(false);
    await expect(getReviewItem(db, item.id)).resolves.toEqual(
      expect.objectContaining({
        state: "failed",
        application: {
          kind: "import_move",
          destination: "04-Resources/Approved/A.md",
        },
      }),
    );
  });

  it("prevents an expired applying worker from completing after takeover", async () => {
    const db = await openTempDb();
    const item = await insertClaimableReview(db, "review-stale-apply");
    await claimReviewItem(db, item.id, {
      from: ["proposed"],
      to: "applying",
      token: "old-worker",
      startedAt: "2000-01-01T00:00:00.000Z",
    });
    await expect(claimReviewItem(db, item.id, {
      from: ["failed"],
      to: "applying",
      token: "new-worker",
      startedAt: "2026-07-29T00:00:00.000Z",
      staleBefore: "2026-07-28T00:00:00.000Z",
      staleClaimToken: "wrong-worker",
    })).resolves.toBe(false);
    await expect(claimReviewItem(db, item.id, {
      from: ["failed"],
      to: "applying",
      token: "new-worker",
      startedAt: "2026-07-29T00:00:00.000Z",
      staleBefore: "2026-07-28T00:00:00.000Z",
      staleClaimToken: "old-worker",
    })).resolves.toBe(true);

    await expect(transitionClaimedReviewItem(
      db,
      item.id,
      "applying",
      "applied",
      "old-worker",
    )).rejects.toThrow("Review claim was lost");
    await expect(renewReviewItemClaim(db, item.id, "applying", "old-worker", new Date().toISOString())).resolves.toBe(false);
    await expect(getReviewItem(db, item.id)).resolves.toEqual(
      expect.objectContaining({ state: "applying", claimToken: "new-worker" }),
    );
    await expect(transitionClaimedReviewItem(
      db,
      item.id,
      "applying",
      "applied",
      "new-worker",
    )).resolves.toBeUndefined();
  });

  it("prevents an expired rejecting worker from completing after takeover", async () => {
    const db = await openTempDb();
    const item = await insertClaimableReview(db, "review-stale-reject");
    await claimReviewItem(db, item.id, {
      from: ["proposed"],
      to: "rejecting",
      token: "old-rejecter",
      startedAt: "2000-01-01T00:00:00.000Z",
    });
    await expect(claimReviewItem(db, item.id, {
      from: ["failed"],
      to: "rejecting",
      token: "new-rejecter",
      startedAt: "2026-07-29T00:00:00.000Z",
      staleBefore: "2026-07-28T00:00:00.000Z",
      staleClaimToken: "old-rejecter",
    })).resolves.toBe(true);

    await expect(transitionClaimedReviewItem(
      db,
      item.id,
      "rejecting",
      "rejected",
      "old-rejecter",
    )).rejects.toThrow("Review claim was lost");
    await expect(getReviewItem(db, item.id)).resolves.toEqual(
      expect.objectContaining({ state: "rejecting", claimToken: "new-rejecter" }),
    );
  });
});

async function insertClaimableReview(db: AppDatabase, id: string): Promise<ReviewItem> {
  const now = new Date().toISOString();
  const workspaceId = `workspace-${id}`;
  db.sqlite
    .prepare("INSERT INTO workspaces (id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(workspaceId, `/tmp/${workspaceId}`, now, now);
  const item: ReviewItem = {
    id,
    workspaceId,
    state: "proposed",
    risk: "high",
    proposalType: "propose_create_note",
    payload: { path: "Note.md", body: "body" },
    reason: "test",
    sourceSessionId: "session",
    sourceTurnId: "turn",
    createdAt: now,
  };
  await createReviewItem(db, item);
  return item;
}

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
      expect.arrayContaining([
        expect.objectContaining({
          noteId: "note-resume",
          snippet: expect.stringContaining("LQ Digital"),
          matchedFields: expect.arrayContaining(["body"]),
        }),
      ]),
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
