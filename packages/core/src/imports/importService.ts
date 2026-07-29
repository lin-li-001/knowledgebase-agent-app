import { randomUUID } from "node:crypto";
import { exportLlmsFlat, importDocumentBatch, indexWorkspace, type ImportJob, type ImportSourceNote } from "@kb-agent/workspace";
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
    await enqueueHighRiskImportCandidates(input.db, workspaceId, job, createdAt);
    await exportLlmsFlat(input.workspaceRoot, input.db);
  }

  const activity = {
    id: randomUUID(),
    workspaceId,
    kind: "import",
    title: job.state === "completed" ? "Import completed" : "Import failed",
    message: job.state === "completed"
      ? `${job.notes.length} files imported.`
      : job.failureReason ?? "Import failed.",
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

async function enqueueHighRiskImportCandidates(db: AppDatabase, workspaceId: string, job: ImportJob, createdAt: string): Promise<void> {
  for (const note of job.notes.filter(
    (item) => item.status === "pending_review" && item.safetyDecision.decision === "review_required",
  )) {
    const reviewItem = reviewItemForImportSourceNote(workspaceId, job, note, createdAt);
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
  }
}

function reviewItemForImportSourceNote(workspaceId: string, job: ImportJob, note: ImportSourceNote, createdAt: string): ReviewItem {
  return {
    id: `import-source-note:${job.id}:${note.notePath}`,
    workspaceId,
    state: "proposed",
    risk: "high",
    proposalType: "propose_create_note",
    targetPath: note.destination ?? note.notePath,
    payload: {
      sourceNotePath: note.notePath,
      destination: note.destination,
    },
    reason: `Imported ${note.sourceFile} is pending review before it moves to ${note.destination}.`,
    sourceSessionId: `import:${job.id}`,
    sourceTurnId: note.notePath,
    createdAt,
  };
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
