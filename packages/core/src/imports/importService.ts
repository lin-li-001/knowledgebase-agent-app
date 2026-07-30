import { randomUUID } from "node:crypto";
import {
  assertInsideWorkspace,
  exportLlmsFlat,
  importDocumentBatch,
  indexWorkspace,
  secureReadWorkspaceText,
  type ImportJob,
  type ImportSourceNote,
} from "@kb-agent/workspace";
import { createReviewItem, recordActivity, type AppDatabase, type ReviewItem } from "@kb-agent/storage";

export interface StartImportBatchInput {
  db: AppDatabase;
  workspaceRoot: string;
  workspaceId: string;
  batchName: string;
  files: string[];
  now?: string;
}

export async function startImportBatch(input: StartImportBatchInput): Promise<ImportJob> {
  const createdAt = input.now ?? new Date().toISOString();
  const job = await importDocumentBatch({
    workspaceRoot: input.workspaceRoot,
    batchName: input.batchName,
    files: input.files,
    now: createdAt,
  });

  const indexResult = await indexWorkspace(input.workspaceRoot, input.db);
  const workspaceId = indexResult.workspaceId;
  await recordImportJob(input.db, workspaceId, job, createdAt);

  if (job.state === "completed") {
    await recordImportSafetyOutcomes(
      input.db,
      workspaceId,
      input.workspaceRoot,
      job,
      createdAt,
    );
    await exportLlmsFlat(input.workspaceRoot, input.db);
  }

  const activity = {
    id: randomUUID(),
    workspaceId,
    kind: "import",
    title: job.state === "completed" ? "Import completed" : "Import failed",
    message: job.state === "completed"
      ? `${job.notes.length} files imported.`
      : failedImportActivityMessage(job),
    createdAt,
  };
  const primaryNotePath = job.notes[0]?.notePath;
  await recordActivity(
    input.db,
    job.state === "completed" && primaryNotePath
      ? { ...activity, entityPath: primaryNotePath }
      : activity,
  );

  return job;
}

async function recordImportSafetyOutcomes(
  db: AppDatabase,
  workspaceId: string,
  workspaceRoot: string,
  job: ImportJob,
  createdAt: string,
): Promise<void> {
  for (const note of job.notes) {
    if (note.safetyDecision.decision === "review_required") {
      const body = await secureReadWorkspaceText(
        workspaceRoot,
        assertInsideWorkspace(workspaceRoot, note.notePath),
        { operation: "review_payload_read" },
      );
      const reviewItem = reviewItemForImportSourceNote(
        workspaceId,
        job,
        note,
        body,
        createdAt,
      );
      await createReviewItem(db, reviewItem);
      await recordActivity(db, {
        id: randomUUID(),
        workspaceId,
        kind: "review",
        title: "Import candidate requires review",
        message: `${note.sourceFile} requires review before moving to ${note.destination}.`,
        entityPath: note.notePath,
        reviewItemId: reviewItem.id,
        createdAt,
      });
    } else if (note.safetyDecision.decision === "blocked") {
      await recordActivity(db, {
        id: randomUUID(),
        workspaceId,
        kind: "error",
        title: "Import candidate blocked",
        message: `${note.sourceFile} remains staged: ${note.safetyDecision.reasonCodes.join(", ")}.`,
        entityPath: note.notePath,
        createdAt,
      });
    }
  }
}

function reviewItemForImportSourceNote(
  workspaceId: string,
  job: ImportJob,
  note: ImportSourceNote,
  body: string,
  createdAt: string,
): ReviewItem {
  return {
    id: `import-source-note:${job.id}:${note.notePath}`,
    workspaceId,
    state: "proposed",
    risk: "high",
    proposalType: "propose_create_note",
    targetPath: note.destination ?? note.notePath,
    payload: {
      sourceNotePath: note.notePath,
      body,
      destination: note.destination,
      classification: note.classification,
      safetyDecision: note.safetyDecision,
      sourceFile: note.sourceFile,
    },
    reason: `Imported ${note.sourceFile} is pending review before it moves to ${note.destination}.`,
    sourceSessionId: `import:${job.id}`,
    sourceTurnId: note.notePath,
    createdAt,
  };
}

function failedImportActivityMessage(job: ImportJob): string {
  const reason = job.failureReason ?? "Import failed.";
  const suffix = job.sourceFiles.length === 1
    ? "Preserved 1 source attachment."
    : `Preserved ${job.sourceFiles.length} source attachments.`;
  return `${reason.replace(/\.$/u, "")}. ${suffix}`;
}

async function recordImportJob(db: AppDatabase, workspaceId: string, job: ImportJob, createdAt: string): Promise<void> {
  db.sqlite
    .prepare(
      `INSERT INTO import_jobs (
        id, workspace_id, batch_name, state, attachment_dir, summary_note_path,
        source_files_json, created_at, completed_at, failure_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.id,
      workspaceId,
      job.batchName,
      job.state,
      job.attachmentDir,
      job.notes[0]?.notePath ?? "",
      JSON.stringify(job.sourceFiles),
      createdAt,
      job.state === "completed" ? createdAt : null,
      job.failureReason ?? null,
    );
}
