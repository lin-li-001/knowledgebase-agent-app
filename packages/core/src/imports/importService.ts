import { randomUUID } from "node:crypto";
import { exportLlmsFlat, importDocumentBatch, indexWorkspace, type ImportJob } from "@kb-agent/workspace";
import { recordActivity, type AppDatabase } from "@kb-agent/storage";

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
    await exportLlmsFlat(input.workspaceRoot, input.db);
  }

  const activity = {
    id: randomUUID(),
    workspaceId,
    kind: "import",
    title: job.state === "completed" ? "Import completed" : "Import failed",
    message: job.state === "completed"
      ? `${job.sourceFiles.length} files imported into ${job.summaryNotePath}.`
      : job.failureReason ?? "Import failed.",
    createdAt,
  };
  await recordActivity(input.db, job.state === "completed" ? { ...activity, entityPath: job.summaryNotePath } : activity);

  return job;
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
      job.summaryNotePath,
      JSON.stringify(job.sourceFiles),
      createdAt,
      job.state === "completed" ? createdAt : null,
      job.failureReason ?? null,
    );
}
