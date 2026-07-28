import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "@kb-agent/storage";
import { startImportBatch } from "../src/index";

let opened: AppDatabase[] = [];

afterEach(() => {
  for (const db of opened) {
    db.close();
  }
  opened = [];
});

describe("startImportBatch", () => {
  it("imports a low-risk source note into Inbox, indexes it, exports llms-flat, and records activity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-sources-"));
    await mkdir(path.join(root, ".app"), { recursive: true });
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);
    const handbook = path.join(sourceDir, "Team Handbook.txt");
    await writeFile(handbook, "Welcome to the team handbook.\n", "utf8");

    const job = await startImportBatch({
      db,
      workspaceRoot: root,
      workspaceId: "workspace-1",
      batchName: "Team Handbook",
      files: [handbook],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.state).toBe("completed");
    expect(db.sqlite.prepare("SELECT state FROM import_jobs WHERE id = ?").get(job.id)).toEqual({ state: "completed" });
    expect(job.notes).toEqual([
      expect.objectContaining({
        notePath: "00-Inbox/Imports/Team Handbook.md",
        routeStatus: "inbox",
      }),
    ]);
    expect(db.sqlite.prepare("SELECT title FROM notes WHERE path = ?").get("00-Inbox/Imports/Team Handbook.md")).toEqual({
      title: "Team Handbook",
    });
    expect(db.sqlite.prepare("SELECT title FROM activity_events WHERE review_item_id IS NULL ORDER BY created_at DESC LIMIT 1").get()).toEqual({
      title: "Import completed",
    });
    await expect(readFile(path.join(root, ".app/exports/llms-flat.txt"), "utf8")).resolves.toContain("title: Team Handbook");
  });

  it("creates one pending Review item for a high-risk source note without creating its destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-sources-"));
    await mkdir(path.join(root, ".app"), { recursive: true });
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);
    const electric = path.join(sourceDir, "2026-01 Electric.txt");
    await writeFile(electric, "Electric bill January 2026\nAmount: $123.45\nDue: 2026-01-15\n", "utf8");

    const job = await startImportBatch({
      db,
      workspaceRoot: root,
      workspaceId: "workspace-1",
      batchName: "2026 Utility Bills",
      files: [electric],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.notes).toEqual([
      expect.objectContaining({
        routeStatus: "pending_review",
        destination: "02-Personal/default/Finance/Utilities/2026/2026-01 Electric.md",
      }),
    ]);
    const sourceNotePath = job.notes[0]!.notePath;
    await expect(readFile(path.join(root, sourceNotePath), "utf8")).resolves.toContain("route_status: pending_review");
    await expect(readFile(path.join(root, "02-Personal/default/Finance/Utilities/2026/2026-01 Electric.md"), "utf8")).rejects.toThrow();

    expect(
      db.sqlite
        .prepare("SELECT proposal_type as proposalType, risk, target_path as targetPath, payload_json as payloadJson FROM review_items")
        .all(),
    ).toEqual([
      {
        proposalType: "propose_create_note",
        risk: "high",
        targetPath: "02-Personal/default/Finance/Utilities/2026/2026-01 Electric.md",
        payloadJson: expect.any(String),
      },
    ]);
    const payload = JSON.parse(
      db.sqlite.prepare("SELECT payload_json as payloadJson FROM review_items LIMIT 1").get().payloadJson,
    );
    expect(payload).toEqual(
      expect.objectContaining({
        sourceNotePath,
        destination: "02-Personal/default/Finance/Utilities/2026/2026-01 Electric.md",
      }),
    );
  });
});
