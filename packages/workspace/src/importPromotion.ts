import { createHash } from "node:crypto";
import path from "node:path";
import { assertApprovedImportFinalNotePath } from "./importSafety";
import { assertInsideWorkspace } from "./pathGuard";
import { defaultRoutingPolicy } from "./routingPolicy";
import {
  secureEnsureWorkspaceDirectory,
  secureReadWorkspaceDirectory,
  secureReadWorkspaceFile,
  secureReadWorkspaceText,
  secureUnlinkWorkspaceFile,
  secureWorkspacePathExists,
  secureWriteWorkspaceFileExclusive,
  syncWorkspaceDirectory,
  type SecureWorkspaceIoHooks,
} from "./secureWorkspaceIo";

export type ImportPromotionStep =
  | "journal_synced"
  | "final_synced"
  | "staging_removed";

export interface ImportPromotionHooks {
  afterDurableStep?(step: ImportPromotionStep): Promise<void>;
}

export interface PromoteImportArtifactInput {
  workspaceRoot: string;
  sourcePath: string;
  stagingPath: string;
  finalPath: string;
  hooks?: ImportPromotionHooks;
  ioHooks?: SecureWorkspaceIoHooks;
  unlinkFile?: (targetPath: string) => Promise<void>;
}

interface ImportPromotionJournal {
  version: 1;
  sourcePath: string;
  stagingPath: string;
  finalPath: string;
  contentHash: string;
}

export async function promoteImportArtifact(
  input: PromoteImportArtifactInput,
): Promise<void> {
  const journal = await validatePromotionInput(input);
  const stagingTargetPath = assertInsideWorkspace(
    input.workspaceRoot,
    journal.stagingPath,
  );
  const finalTargetPath = assertApprovedImportFinalNotePath(
    input.workspaceRoot,
    journal.finalPath,
  );
  const body = await secureReadWorkspaceFile(
    input.workspaceRoot,
    stagingTargetPath,
    { operation: "staging_read", hooks: input.ioHooks },
  );
  if (hashContents(body) !== journal.contentHash) {
    throw new Error("Staging artifact changed before promotion");
  }
  if (await secureWorkspacePathExists(input.workspaceRoot, finalTargetPath)) {
    throw fileExistsError("Import promotion destination already exists");
  }

  const journalPath = promotionJournalPath(input.workspaceRoot, journal);
  const journalDir = path.dirname(journalPath);
  await secureEnsureWorkspaceDirectory(input.workspaceRoot, journalDir);
  await secureWriteWorkspaceFileExclusive(
    input.workspaceRoot,
    journalPath,
    `${JSON.stringify(journal)}\n`,
    { operation: "journal_create", hooks: input.ioHooks },
  );
  await syncWorkspaceDirectory(input.workspaceRoot, journalDir);
  await input.hooks?.afterDurableStep?.("journal_synced");

  await secureWriteWorkspaceFileExclusive(
    input.workspaceRoot,
    finalTargetPath,
    body,
    { operation: "final_create", hooks: input.ioHooks },
  );
  await syncWorkspaceDirectory(
    input.workspaceRoot,
    path.dirname(finalTargetPath),
  );
  await input.hooks?.afterDurableStep?.("final_synced");

  await secureUnlinkWorkspaceFile(
    input.workspaceRoot,
    stagingTargetPath,
    {
      operation: "staging_unlink",
      hooks: input.ioHooks,
      unlinkFile: input.unlinkFile,
    },
  );
  await syncWorkspaceDirectory(
    input.workspaceRoot,
    path.dirname(stagingTargetPath),
  );
  await input.hooks?.afterDurableStep?.("staging_removed");

  await secureUnlinkWorkspaceFile(
    input.workspaceRoot,
    journalPath,
    { operation: "journal_unlink", hooks: input.ioHooks },
  );
  await syncWorkspaceDirectory(input.workspaceRoot, journalDir);
}

export async function recoverImportPromotions(
  workspaceRoot: string,
  options: { ioHooks?: SecureWorkspaceIoHooks } = {},
): Promise<void> {
  const journalDir = assertInsideWorkspace(
    workspaceRoot,
    defaultRoutingPolicy.importPromotionJournalDir(),
  );
  await secureEnsureWorkspaceDirectory(workspaceRoot, journalDir);
  const journalNames = await secureReadWorkspaceDirectory(
    workspaceRoot,
    journalDir,
    { operation: "journal_list", hooks: options.ioHooks },
  );

  for (const journalName of journalNames.sort()) {
    if (!journalName.endsWith(".json")) {
      continue;
    }
    const journalPath = assertInsideWorkspace(
      workspaceRoot,
      path.join(defaultRoutingPolicy.importPromotionJournalDir(), journalName),
    );
    const journal = parsePromotionJournal(
      await secureReadWorkspaceText(
        workspaceRoot,
        journalPath,
        { operation: "journal_read", hooks: options.ioHooks },
      ),
    );
    await recoverPromotion(workspaceRoot, journal, journalPath, options.ioHooks);
  }
}

export async function discardImportPromotionJournal(
  workspaceRoot: string,
  sourcePath: string,
  stagingPath: string,
  finalPath: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  const journal: ImportPromotionJournal = {
    version: 1,
    sourcePath: normalizedRelativePath(workspaceRoot, sourcePath),
    stagingPath: normalizedRelativePath(workspaceRoot, stagingPath),
    finalPath: normalizedRelativePath(workspaceRoot, finalPath),
    contentHash: "",
  };
  const journalPath = promotionJournalPath(workspaceRoot, journal);
  if (!await secureWorkspacePathExists(workspaceRoot, journalPath)) {
    return;
  }
  await secureUnlinkWorkspaceFile(
    workspaceRoot,
    journalPath,
    { operation: "journal_discard", hooks: ioHooks },
  );
  await syncWorkspaceDirectory(workspaceRoot, path.dirname(journalPath));
}

async function validatePromotionInput(
  input: PromoteImportArtifactInput,
): Promise<ImportPromotionJournal> {
  const sourcePath = normalizedImportSourcePath(
    input.workspaceRoot,
    input.sourcePath,
  );
  const stagingPath = normalizedImportStagingPath(
    input.workspaceRoot,
    input.stagingPath,
  );
  const finalTargetPath = assertApprovedImportFinalNotePath(
    input.workspaceRoot,
    input.finalPath,
  );
  const finalPath = normalizedRelativePath(
    input.workspaceRoot,
    finalTargetPath,
  );
  if (!await secureWorkspacePathExists(input.workspaceRoot, sourcePath)) {
    throw new Error("Import source attachment is missing");
  }
  if (!await secureWorkspacePathExists(input.workspaceRoot, stagingPath)) {
    throw new Error("Import staging artifact is missing");
  }
  const body = await secureReadWorkspaceFile(
    input.workspaceRoot,
    stagingPath,
    { operation: "staging_hash", hooks: input.ioHooks },
  );
  return {
    version: 1,
    sourcePath: normalizedRelativePath(input.workspaceRoot, sourcePath),
    stagingPath: normalizedRelativePath(input.workspaceRoot, stagingPath),
    finalPath,
    contentHash: hashContents(body),
  };
}

async function recoverPromotion(
  workspaceRoot: string,
  journal: ImportPromotionJournal,
  journalPath: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  const sourcePath = normalizedImportSourcePath(workspaceRoot, journal.sourcePath);
  const stagingPath = normalizedImportStagingPath(
    workspaceRoot,
    journal.stagingPath,
  );
  const finalPath = assertApprovedImportFinalNotePath(
    workspaceRoot,
    journal.finalPath,
  );
  if (!await secureWorkspacePathExists(workspaceRoot, sourcePath)) {
    throw new Error("Promotion source attachment is missing");
  }

  const stagingExists = await secureWorkspacePathExists(
    workspaceRoot,
    stagingPath,
  );
  const finalExists = await secureWorkspacePathExists(workspaceRoot, finalPath);
  if (!stagingExists && !finalExists) {
    throw new Error("Promotion journal has no remaining artifact");
  }

  let stagingBody: Buffer | undefined;
  if (stagingExists) {
    stagingBody = await secureReadWorkspaceFile(
      workspaceRoot,
      stagingPath,
      { operation: "staging_recover", hooks: ioHooks },
    );
    if (hashContents(stagingBody) !== journal.contentHash) {
      throw new Error("Promotion staging artifact does not match its journal hash");
    }
  }

  if (finalExists) {
    const finalBody = await secureReadWorkspaceFile(
      workspaceRoot,
      finalPath,
      { operation: "final_recover", hooks: ioHooks },
    );
    if (hashContents(finalBody) !== journal.contentHash) {
      throw new Error("Promotion destination does not match its journal hash");
    }
  } else {
    if (!stagingBody) {
      throw new Error("Promotion staging artifact is missing");
    }
    await secureWriteWorkspaceFileExclusive(
      workspaceRoot,
      finalPath,
      stagingBody,
      { operation: "final_recover_create", hooks: ioHooks },
    );
    await syncWorkspaceDirectory(workspaceRoot, path.dirname(finalPath));
  }

  if (stagingExists) {
    await secureUnlinkWorkspaceFile(
      workspaceRoot,
      stagingPath,
      { operation: "staging_recover_unlink", hooks: ioHooks },
    );
    await syncWorkspaceDirectory(workspaceRoot, path.dirname(stagingPath));
  }
  await secureUnlinkWorkspaceFile(
    workspaceRoot,
    journalPath,
    { operation: "journal_recover_unlink", hooks: ioHooks },
  );
  await syncWorkspaceDirectory(workspaceRoot, path.dirname(journalPath));
}

function parsePromotionJournal(raw: string): ImportPromotionJournal {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value)
    || value.version !== 1
    || typeof value.sourcePath !== "string"
    || typeof value.stagingPath !== "string"
    || typeof value.finalPath !== "string"
    || typeof value.contentHash !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.contentHash)
  ) {
    throw new Error("Invalid import promotion journal");
  }
  return {
    version: 1,
    sourcePath: value.sourcePath,
    stagingPath: value.stagingPath,
    finalPath: value.finalPath,
    contentHash: value.contentHash,
  };
}

function promotionJournalPath(
  workspaceRoot: string,
  journal: ImportPromotionJournal,
): string {
  const journalId = createHash("sha256")
    .update(`${journal.sourcePath}\0${journal.stagingPath}\0${journal.finalPath}`)
    .digest("hex");
  return assertInsideWorkspace(
    workspaceRoot,
    defaultRoutingPolicy.importPromotionJournalPath(journalId),
  );
}

function normalizedImportSourcePath(
  workspaceRoot: string,
  sourcePath: string,
): string {
  const normalized = assertInsideWorkspace(workspaceRoot, sourcePath);
  const relative = normalizedRelativePath(workspaceRoot, normalized);
  if (!relative.startsWith(`${defaultRoutingPolicy.importAttachmentRoot()}/`)) {
    throw new Error("Import promotion source is not an attachment");
  }
  return normalized;
}

function normalizedImportStagingPath(
  workspaceRoot: string,
  stagingPath: string,
): string {
  const normalized = assertInsideWorkspace(workspaceRoot, stagingPath);
  const relative = normalizedRelativePath(workspaceRoot, normalized);
  if (
    !relative.startsWith(`${defaultRoutingPolicy.importStagingRoot()}/`)
    || path.posix.extname(relative) !== ".md"
  ) {
    throw new Error("Import promotion source is not a staged Markdown note");
  }
  return normalized;
}

function normalizedRelativePath(
  workspaceRoot: string,
  targetPath: string,
): string {
  return path
    .relative(
      path.resolve(workspaceRoot),
      assertInsideWorkspace(workspaceRoot, targetPath),
    )
    .split(path.sep)
    .join("/");
}

function hashContents(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function fileExistsError(message: string): Error {
  return Object.assign(new Error(message), { code: "EEXIST" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
