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
  it("imports documents, indexes the generated summary, exports llms-flat, and records activity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-sources-"));
    await mkdir(path.join(root, ".app"), { recursive: true });
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);
    const electric = path.join(sourceDir, "2026-01 Electric.txt");
    const water = path.join(sourceDir, "2026-02 Water.txt");
    await writeFile(electric, "Electric bill January 2026\nAmount: $123.45\nDue: 2026-01-15\n", "utf8");
    await writeFile(water, "Water bill February 2026\nAmount: $67.89\nDue: 2026-02-14\n", "utf8");

    const job = await startImportBatch({
      db,
      workspaceRoot: root,
      workspaceId: "workspace-1",
      batchName: "2026 Utility Bills",
      files: [electric, water],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job.state).toBe("completed");
    expect(db.sqlite.prepare("SELECT state FROM import_jobs WHERE id = ?").get(job.id)).toEqual({ state: "completed" });
    expect(db.sqlite.prepare("SELECT title FROM notes WHERE path = ?").get("04-Resources/Imports/2026 Utility Bills.md")).toEqual({
      title: "2026 Utility Bills",
    });
    expect(db.sqlite.prepare("SELECT title FROM activity_events WHERE review_item_id IS NULL ORDER BY created_at DESC LIMIT 1").get()).toEqual({
      title: "Import completed",
    });
    await expect(readFile(path.join(root, ".app/exports/llms-flat.txt"), "utf8")).resolves.toContain("title: 2026 Utility Bills");
  });
});
