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
  it("auto-writes a safe source note, indexes it, exports llms-flat, and records activity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-sources-"));
    await mkdir(path.join(root, ".app"), { recursive: true });
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);
    const handbook = path.join(sourceDir, "Team Handbook.txt");
    await mkdir(path.join(root, ".vault"), { recursive: true });
    await writeFile(
      path.join(root, ".vault/routing-policy.json"),
      JSON.stringify({ rules: [{ pattern: "Team Handbook", category: "resource", sensitivity: "normal", destination: "00-Inbox/Imports/Team Handbook.md" }] }),
      "utf8",
    );
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
        status: "auto_written",
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

  it("creates exactly one Review item with the complete safety context for a review-required source note", async () => {
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
        status: "pending_review",
        safetyDecision: expect.objectContaining({ decision: "review_required" }),
        destination: "02-Personal/default/Finance/Utilities/2026/2026-01 Electric.md",
      }),
    ]);
    const sourceNotePath = job.notes[0]!.notePath;
    const stagedBody = await readFile(path.join(root, sourceNotePath), "utf8");
    expect(stagedBody).toContain("route_status: pending_review");
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
        body: stagedBody,
        destination: "02-Personal/default/Finance/Utilities/2026/2026-01 Electric.md",
        sourceFile: "2026-01 Electric.txt",
        classification: expect.objectContaining({
          primaryCategory: "finance.utility",
          sensitivity: "personal",
          confidence: 0.8,
          evidence: ["Amount: $123.45", "Due: 2026-01-15"],
        }),
        safetyDecision: expect.objectContaining({
          decision: "review_required",
          reasonCodes: expect.arrayContaining([
            "CONFIDENCE_BELOW_THRESHOLD",
            "SENSITIVITY_REQUIRES_REVIEW",
            "CATEGORY_REQUIRES_REVIEW",
            "DESTINATION_REQUIRES_REVIEW",
          ]),
        }),
      }),
    );
  });

  it("records a blocked import as an error without creating an approvable Review item", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-sources-"));
    const destination = "02-Personal/default/Finance/Utilities/2026/2026-01 Electric.md";
    await mkdir(path.join(root, ".app"), { recursive: true });
    await mkdir(path.dirname(path.join(root, destination)), { recursive: true });
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);
    const electric = path.join(sourceDir, "2026-01 Electric.txt");
    const existingNote = `---
title: Existing Electric Bill
type: resource
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-01-01
tags: []
---

# Existing Electric Bill
`;
    await writeFile(path.join(root, destination), existingNote, "utf8");
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
        status: "blocked",
        notePath: expect.stringMatching(/^\.app\/import-staging\//u),
        safetyDecision: {
          decision: "blocked",
          reasonCodes: ["DESTINATION_EXISTS"],
        },
      }),
    ]);
    expect(db.sqlite.prepare("SELECT COUNT(*) as count FROM review_items").get()).toEqual({ count: 0 });
    expect(
      db.sqlite
        .prepare("SELECT kind, title, entity_path as entityPath FROM activity_events WHERE title = ?")
        .get("Import candidate blocked"),
    ).toEqual({
      kind: "error",
      title: "Import candidate blocked",
      entityPath: job.notes[0]!.notePath,
    });
    await expect(readFile(path.join(root, job.notes[0]!.notePath), "utf8")).resolves.toContain("route_status: blocked");
    await expect(readFile(path.join(root, destination), "utf8")).resolves.toBe(existingNote);
  });

  it("records a failed import job when a source file cannot be imported", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-core-import-sources-"));
    await mkdir(path.join(root, ".app"), { recursive: true });
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);
    const unsupported = path.join(sourceDir, "Handbook.docx");
    await writeFile(unsupported, "not a real docx", "utf8");

    const job = await startImportBatch({
      db,
      workspaceRoot: root,
      workspaceId: "workspace-1",
      batchName: "Handbook",
      files: [unsupported],
      now: "2026-07-21T00:00:00.000Z",
    });

    expect(job).toMatchObject({
      state: "failed",
      failureReason: "Invalid or unreadable DOCX file",
      sourceFiles: ["06-Attachments/Imports/Handbook/Handbook.docx"],
    });
    await expect(
      readFile(path.join(root, "06-Attachments/Imports/Handbook/Handbook.docx"), "utf8"),
    ).resolves.toBe("not a real docx");
    expect(db.sqlite.prepare("SELECT state, summary_note_path as summaryNotePath FROM import_jobs WHERE id = ?").get(job.id)).toEqual({
      state: "failed",
      summaryNotePath: "",
    });
    expect(
      db.sqlite
        .prepare("SELECT message FROM activity_events WHERE title = 'Import failed' ORDER BY created_at DESC LIMIT 1")
        .get(),
    ).toEqual({
      message: "Invalid or unreadable DOCX file. Preserved 1 source attachment.",
    });
  });
});
