import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertApprovedImportFinalNotePath } from "./importSafety";
import { parseMarkdownDocument } from "./markdown";
import { assertInsideWorkspace } from "./pathGuard";
import { defaultRoutingPolicy } from "./routingPolicy";
import {
  secureAtomicReplaceWorkspaceFile,
  secureEnsureWorkspaceDirectory,
  securePublishWorkspaceFileAtomic,
  secureQuarantineWorkspaceArtifact,
  secureReadWorkspaceArtifact,
  secureReadWorkspaceDirectory,
  secureRemoveWorkspaceArtifact,
  secureWorkspacePathExists,
  type SecureWorkspaceArtifactIdentity,
  type SecureWorkspaceIoHooks,
} from "./secureWorkspaceIo";

export type ImportPromotionStep =
  | "journal_temp_partial"
  | "journal_synced"
  | "final_temp_synced"
  | "final_published"
  | "final_synced"
  | "staging_quarantined"
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

export interface ImportPromotionResult {
  final: SecureWorkspaceArtifactIdentity;
}

type PromotionPhase =
  | "prepared"
  | "final_temp_synced"
  | "final_published"
  | "staging_quarantined"
  | "staging_removed";

interface RecordedArtifact {
  path: string;
  parentPath: string;
  parentRealPath: string;
  parentDev: number;
  parentIno: number;
  dev: number;
  ino: number;
  sha256: string;
  size: number;
}

interface ImportPromotionJournal {
  version: 2;
  transactionId: string;
  phase: PromotionPhase;
  attachment: RecordedArtifact;
  staging: RecordedArtifact;
  finalPath: string;
  expectedFinalHash: string;
  stagingQuarantinePath: string;
  finalTemp?: RecordedArtifact;
  final?: RecordedArtifact;
}

interface LegacyImportPromotionJournal {
  version: 1;
  sourcePath: string;
  stagingPath: string;
  finalPath: string;
  contentHash: string;
}

interface JournalHandle {
  path: string;
  artifact: SecureWorkspaceArtifactIdentity;
  journal: ImportPromotionJournal;
}

export async function promoteImportArtifact(
  input: PromoteImportArtifactInput,
): Promise<ImportPromotionResult> {
  const prepared = await validatePromotionInput(input);
  if (await secureWorkspacePathExists(
    input.workspaceRoot,
    assertApprovedImportFinalNotePath(input.workspaceRoot, prepared.journal.finalPath),
  )) {
    throw fileExistsError("Import promotion destination already exists");
  }

  const handle = await createPromotionJournal(input, prepared.journal);
  await input.hooks?.afterDurableStep?.("journal_synced");

  const body = prepared.staging.contents;
  let final: SecureWorkspaceArtifactIdentity;
  try {
    final = await publishFinal(input, handle, body);
  } catch (error) {
    throw error;
  }

  try {
    await verifyRetirementBindings(
      input.workspaceRoot,
      handle.journal,
      input.ioHooks,
    );
  } catch (error) {
    await rollbackPublishedFinal(input.workspaceRoot, handle.journal, input.ioHooks);
    await quarantineJournal(input.workspaceRoot, handle, "aborted", input.ioHooks);
    throw error;
  }

  await retireStaging(input, handle);
  await removeJournal(input.workspaceRoot, handle, input.ioHooks);
  return { final };
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
    const journalPath = assertInsideWorkspace(
      workspaceRoot,
      path.join(defaultRoutingPolicy.importPromotionJournalDir(), journalName),
    );
    if (isJournalTempName(journalName)) {
      await cleanupJournalTemp(workspaceRoot, journalPath, options.ioHooks);
      continue;
    }
    if (!journalName.endsWith(".json")) {
      continue;
    }

    let snapshot;
    try {
      snapshot = await secureReadWorkspaceArtifact(
        workspaceRoot,
        journalPath,
        { operation: "journal_read", hooks: options.ioHooks },
      );
    } catch {
      continue;
    }

    let journal: ImportPromotionJournal | LegacyImportPromotionJournal;
    try {
      journal = parsePromotionJournal(snapshot.contents.toString("utf8"));
      if (journal.version === 2) {
        validateJournalForWorkspace(workspaceRoot, journal);
      }
    } catch {
      await secureQuarantineWorkspaceArtifact(
        workspaceRoot,
        snapshot.artifact,
        "malformed",
        { operation: "journal_malformed", hooks: options.ioHooks },
      );
      continue;
    }

    let upgraded: ImportPromotionJournal;
    try {
      upgraded = journal.version === 1
        ? await upgradeLegacyJournal(
          workspaceRoot,
          journal,
          path.basename(journalName, ".json"),
        )
        : journal;
      validateJournalForWorkspace(workspaceRoot, upgraded);
    } catch {
      await secureQuarantineWorkspaceArtifact(
        workspaceRoot,
        snapshot.artifact,
        "malformed",
        { operation: "journal_malformed", hooks: options.ioHooks },
      );
      continue;
    }
    const handle: JournalHandle = {
      path: journalPath,
      artifact: snapshot.artifact,
      journal: upgraded,
    };
    if (journal.version === 1) {
      await persistJournal(workspaceRoot, handle, options.ioHooks);
    }
    await recoverPromotion(workspaceRoot, handle, options.ioHooks);
  }
}

export async function discardImportPromotionJournal(
  workspaceRoot: string,
  sourcePath: string,
  stagingPath: string,
  finalPath: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  const expected = {
    sourcePath: normalizedRelativePath(
      workspaceRoot,
      normalizedImportSourcePath(workspaceRoot, sourcePath),
    ),
    stagingPath: normalizedRelativePath(
      workspaceRoot,
      normalizedImportStagingPath(workspaceRoot, stagingPath),
    ),
    finalPath: normalizedRelativePath(
      workspaceRoot,
      assertApprovedImportFinalNotePath(workspaceRoot, finalPath),
    ),
  };
  const journalDir = assertInsideWorkspace(
    workspaceRoot,
    defaultRoutingPolicy.importPromotionJournalDir(),
  );
  await secureEnsureWorkspaceDirectory(workspaceRoot, journalDir);
  for (const name of await secureReadWorkspaceDirectory(
    workspaceRoot,
    journalDir,
    { operation: "journal_discard_list", hooks: ioHooks },
  )) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const journalPath = path.join(journalDir, name);
    const snapshot = await secureReadWorkspaceArtifact(
      workspaceRoot,
      journalPath,
      { operation: "journal_discard_read", hooks: ioHooks },
    );
    let value: ImportPromotionJournal | LegacyImportPromotionJournal;
    try {
      value = parsePromotionJournal(snapshot.contents.toString("utf8"));
    } catch {
      continue;
    }
    const matches = value.version === 1
      ? value.sourcePath === expected.sourcePath
        && value.stagingPath === expected.stagingPath
        && value.finalPath === expected.finalPath
      : value.attachment.path === expected.sourcePath
        && value.staging.path === expected.stagingPath
        && value.finalPath === expected.finalPath;
    if (!matches) {
      continue;
    }
    if (value.version === 2 && value.finalTemp) {
      await removeRecordedIfOwned(
        workspaceRoot,
        value.finalTemp,
        "final_temp_discard",
        ioHooks,
      );
    }
    await secureRemoveWorkspaceArtifact(workspaceRoot, snapshot.artifact, {
      operation: "journal_discard",
      hooks: ioHooks,
    });
  }
}

async function validatePromotionInput(
  input: PromoteImportArtifactInput,
): Promise<{
  journal: ImportPromotionJournal;
  staging: Awaited<ReturnType<typeof secureReadWorkspaceArtifact>>;
}> {
  const sourcePath = normalizedImportSourcePath(
    input.workspaceRoot,
    input.sourcePath,
  );
  const stagingPath = normalizedImportStagingPath(
    input.workspaceRoot,
    input.stagingPath,
  );
  const finalPath = normalizedRelativePath(
    input.workspaceRoot,
    assertApprovedImportFinalNotePath(input.workspaceRoot, input.finalPath),
  );
  const attachment = await secureReadWorkspaceArtifact(
    input.workspaceRoot,
    sourcePath,
    { operation: "attachment_hash", hooks: input.ioHooks },
  );
  const staging = await secureReadWorkspaceArtifact(
    input.workspaceRoot,
    stagingPath,
    { operation: "staging_hash", hooks: input.ioHooks },
  );
  assertStagingAttachmentBinding(
    input.workspaceRoot,
    assertApprovedImportFinalNotePath(input.workspaceRoot, finalPath),
    staging.contents,
    attachment.artifact.targetPath,
  );
  const transactionId = randomUUID();
  return {
    journal: {
      version: 2,
      transactionId,
      phase: "prepared",
      attachment: recordArtifact(input.workspaceRoot, attachment.artifact),
      staging: recordArtifact(input.workspaceRoot, staging.artifact),
      finalPath,
      expectedFinalHash: staging.artifact.sha256,
      stagingQuarantinePath: normalizedRelativePath(
        input.workspaceRoot,
        path.join(
          path.dirname(staging.artifact.targetPath),
          `.${path.basename(staging.artifact.targetPath)}.${transactionId}.retired`,
        ),
      ),
    },
    staging,
  };
}

async function createPromotionJournal(
  input: PromoteImportArtifactInput,
  journal: ImportPromotionJournal,
): Promise<JournalHandle> {
  const journalPath = assertInsideWorkspace(
    input.workspaceRoot,
    defaultRoutingPolicy.importPromotionJournalPath(journal.transactionId),
  );
  await secureEnsureWorkspaceDirectory(input.workspaceRoot, path.dirname(journalPath));
  const artifact = await secureAtomicReplaceWorkspaceFile(
    input.workspaceRoot,
    journalPath,
    serializeJournal(journal),
    {
      operation: "journal_create",
      hooks: promotionJournalHooks(input.ioHooks, input.hooks),
      requireAbsent: true,
    },
  );
  return { path: journalPath, artifact, journal };
}

async function publishFinal(
  input: PromoteImportArtifactInput,
  handle: JournalHandle,
  body: Buffer,
): Promise<SecureWorkspaceArtifactIdentity> {
  const finalPath = assertApprovedImportFinalNotePath(
    input.workspaceRoot,
    handle.journal.finalPath,
  );
  return securePublishWorkspaceFileAtomic(
    input.workspaceRoot,
    finalPath,
    body,
    {
      operation: "final_create",
      hooks: input.ioHooks,
      afterTempSync: async (temp) => {
        handle.journal = {
          ...handle.journal,
          phase: "final_temp_synced",
          finalTemp: recordArtifact(input.workspaceRoot, temp),
        };
        await persistJournal(input.workspaceRoot, handle, input.ioHooks);
        await input.hooks?.afterDurableStep?.("final_temp_synced");
      },
      afterPublish: async (final) => {
        handle.journal = {
          ...handle.journal,
          phase: "final_published",
          final: recordArtifact(input.workspaceRoot, final),
        };
        await persistJournal(input.workspaceRoot, handle, input.ioHooks);
        await input.hooks?.afterDurableStep?.("final_published");
        await input.hooks?.afterDurableStep?.("final_synced");
      },
    },
  );
}

async function retireStaging(
  input: PromoteImportArtifactInput,
  handle: JournalHandle,
): Promise<void> {
  const staging = artifactFromRecord(input.workspaceRoot, handle.journal.staging);
  await secureRemoveWorkspaceArtifact(input.workspaceRoot, staging, {
    operation: "staging_retire",
    hooks: input.ioHooks,
    unlinkFile: input.unlinkFile,
    quarantinePath: assertInsideWorkspace(
      input.workspaceRoot,
      handle.journal.stagingQuarantinePath,
    ),
    afterQuarantine: async () => {
      handle.journal = {
        ...handle.journal,
        phase: "staging_quarantined",
      };
      await persistJournal(input.workspaceRoot, handle, input.ioHooks);
      await input.hooks?.afterDurableStep?.("staging_quarantined");
    },
  });
  handle.journal = { ...handle.journal, phase: "staging_removed" };
  await persistJournal(input.workspaceRoot, handle, input.ioHooks);
  await input.hooks?.afterDurableStep?.("staging_removed");
}

async function verifyRetirementBindings(
  workspaceRoot: string,
  journal: ImportPromotionJournal,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  let staging;
  try {
    staging = await secureReadWorkspaceArtifact(
      workspaceRoot,
      artifactFromRecord(workspaceRoot, journal.staging).targetPath,
      {
        operation: "staging_retire",
        hooks: ioHooks,
        expectedArtifact: artifactFromRecord(workspaceRoot, journal.staging),
      },
    );
  } catch {
    throw new Error("Promotion staging artifact changed before retirement");
  }
  let attachment;
  try {
    attachment = await secureReadWorkspaceArtifact(
      workspaceRoot,
      artifactFromRecord(workspaceRoot, journal.attachment).targetPath,
      {
        operation: "attachment_retire",
        expectedArtifact: artifactFromRecord(workspaceRoot, journal.attachment),
      },
    );
  } catch {
    throw new Error("Promotion attachment changed before retirement");
  }
  assertStagingAttachmentBinding(
    workspaceRoot,
    assertApprovedImportFinalNotePath(workspaceRoot, journal.finalPath),
    staging.contents,
    attachment.artifact.targetPath,
  );
}

async function recoverPromotion(
  workspaceRoot: string,
  handle: JournalHandle,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  const journal = handle.journal;
  const attachment = artifactFromRecord(workspaceRoot, journal.attachment);
  try {
    await secureReadWorkspaceArtifact(workspaceRoot, attachment.targetPath, {
      operation: "attachment_recover",
      expectedArtifact: attachment,
    });
  } catch {
    await rollbackPublishedFinal(workspaceRoot, journal, ioHooks);
    await quarantineJournal(workspaceRoot, handle, "attachment-changed", ioHooks);
    return;
  }

  const stagingPath = artifactFromRecord(workspaceRoot, journal.staging).targetPath;
  const quarantinePath = assertInsideWorkspace(
    workspaceRoot,
    journal.stagingQuarantinePath,
  );
  const stagingExists = await secureWorkspacePathExists(workspaceRoot, stagingPath);
  const quarantineExists = await secureWorkspacePathExists(workspaceRoot, quarantinePath);
  const finalPath = assertApprovedImportFinalNotePath(workspaceRoot, journal.finalPath);
  const finalExists = await secureWorkspacePathExists(workspaceRoot, finalPath);

  let sourceSnapshot;
  if (stagingExists) {
    try {
      sourceSnapshot = await secureReadWorkspaceArtifact(workspaceRoot, stagingPath, {
        operation: "staging_recover",
        expectedArtifact: artifactFromRecord(workspaceRoot, journal.staging),
      });
    } catch {
      await rollbackPublishedFinal(workspaceRoot, journal, ioHooks);
      await quarantineJournal(workspaceRoot, handle, "staging-changed", ioHooks);
      return;
    }
  } else if (quarantineExists) {
    const expected = {
      ...artifactFromRecord(workspaceRoot, journal.staging),
      targetPath: quarantinePath,
    };
    sourceSnapshot = await secureReadWorkspaceArtifact(
      workspaceRoot,
      quarantinePath,
      { operation: "staging_quarantine_recover", expectedArtifact: expected },
    );
  }

  if (finalExists) {
    await verifyRecordedFinal(workspaceRoot, journal);
  } else {
    if (!sourceSnapshot) {
      throw new Error("Promotion journal has no remaining artifact");
    }
    if (handle.journal.finalTemp) {
      try {
        await removeRecordedIfOwned(
          workspaceRoot,
          handle.journal.finalTemp,
          "final_temp_recover_replace",
          ioHooks,
        );
      } catch {
        await quarantineJournal(workspaceRoot, handle, "final-temp-changed", ioHooks);
        return;
      }
    }
    await publishRecoveredFinal(
      workspaceRoot,
      handle,
      sourceSnapshot.contents,
      ioHooks,
    );
  }

  if (stagingExists) {
    await verifyRetirementBindings(workspaceRoot, handle.journal, ioHooks);
    await secureRemoveWorkspaceArtifact(
      workspaceRoot,
      artifactFromRecord(workspaceRoot, handle.journal.staging),
      {
        operation: "staging_recover_retire",
        hooks: ioHooks,
        quarantinePath,
        afterQuarantine: async () => {
          handle.journal = {
            ...handle.journal,
            phase: "staging_quarantined",
          };
          await persistJournal(workspaceRoot, handle, ioHooks);
        },
      },
    );
  } else if (quarantineExists && sourceSnapshot) {
    await secureRemoveWorkspaceArtifact(
      workspaceRoot,
      sourceSnapshot.artifact,
      { operation: "staging_recover_quarantine_cleanup", hooks: ioHooks },
    );
  }

  handle.journal = { ...handle.journal, phase: "staging_removed" };
  await persistJournal(workspaceRoot, handle, ioHooks);
  if (handle.journal.finalTemp) {
    await removeRecordedIfOwned(
      workspaceRoot,
      handle.journal.finalTemp,
      "final_temp_recover_cleanup",
      ioHooks,
    );
  }
  await removeJournal(workspaceRoot, handle, ioHooks);
}

async function publishRecoveredFinal(
  workspaceRoot: string,
  handle: JournalHandle,
  body: Buffer,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  const finalPath = assertApprovedImportFinalNotePath(
    workspaceRoot,
    handle.journal.finalPath,
  );
  await securePublishWorkspaceFileAtomic(workspaceRoot, finalPath, body, {
    operation: "final_recover_create",
    hooks: ioHooks,
    afterTempSync: async (temp) => {
      handle.journal = {
        ...handle.journal,
        phase: "final_temp_synced",
        finalTemp: recordArtifact(workspaceRoot, temp),
      };
      await persistJournal(workspaceRoot, handle, ioHooks);
    },
    afterPublish: async (final) => {
      handle.journal = {
        ...handle.journal,
        phase: "final_published",
        final: recordArtifact(workspaceRoot, final),
      };
      await persistJournal(workspaceRoot, handle, ioHooks);
    },
  });
}

async function verifyRecordedFinal(
  workspaceRoot: string,
  journal: ImportPromotionJournal,
): Promise<void> {
  const finalPath = assertApprovedImportFinalNotePath(
    workspaceRoot,
    journal.finalPath,
  );
  const recorded = journal.final ?? journal.finalTemp;
  if (!recorded) {
    throw new Error(
      "Promotion destination does not match its journal hash or identity",
    );
  }
  const expected = {
    ...artifactFromRecord(workspaceRoot, recorded),
    targetPath: finalPath,
  };
  try {
    await secureReadWorkspaceArtifact(workspaceRoot, finalPath, {
      operation: "final_recover",
      expectedArtifact: expected,
    });
  } catch {
    throw new Error(
      "Promotion destination does not match its journal hash or identity",
    );
  }
}

async function rollbackPublishedFinal(
  workspaceRoot: string,
  journal: ImportPromotionJournal,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  if (!journal.final) {
    return;
  }
  await removeRecordedIfOwned(
    workspaceRoot,
    journal.final,
    "final_rollback",
    ioHooks,
  );
}

async function removeRecordedIfOwned(
  workspaceRoot: string,
  recorded: RecordedArtifact,
  operation: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  const artifact = artifactFromRecord(workspaceRoot, recorded);
  if (!await secureWorkspacePathExists(workspaceRoot, artifact.targetPath)) {
    return;
  }
  await secureRemoveWorkspaceArtifact(workspaceRoot, artifact, {
    operation,
    hooks: ioHooks,
  });
}

async function persistJournal(
  workspaceRoot: string,
  handle: JournalHandle,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  handle.artifact = await secureAtomicReplaceWorkspaceFile(
    workspaceRoot,
    handle.path,
    serializeJournal(handle.journal),
    {
      operation: "journal_update",
      hooks: ioHooks,
      expectedArtifact: handle.artifact,
    },
  );
}

async function removeJournal(
  workspaceRoot: string,
  handle: JournalHandle,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  await secureRemoveWorkspaceArtifact(workspaceRoot, handle.artifact, {
    operation: "journal_complete",
    hooks: ioHooks,
  });
}

async function quarantineJournal(
  workspaceRoot: string,
  handle: JournalHandle,
  label: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  if (!await secureWorkspacePathExists(workspaceRoot, handle.path)) {
    return;
  }
  await secureQuarantineWorkspaceArtifact(
    workspaceRoot,
    handle.artifact,
    label,
    { operation: "journal_quarantine", hooks: ioHooks },
  );
}

async function cleanupJournalTemp(
  workspaceRoot: string,
  journalPath: string,
  ioHooks?: SecureWorkspaceIoHooks,
): Promise<void> {
  try {
    const snapshot = await secureReadWorkspaceArtifact(
      workspaceRoot,
      journalPath,
      { operation: "journal_temp_read", hooks: ioHooks },
    );
    await secureRemoveWorkspaceArtifact(workspaceRoot, snapshot.artifact, {
      operation: "journal_temp_cleanup",
      hooks: ioHooks,
    });
  } catch {
    // A temp that cannot be proven transaction-owned is ignored.
  }
}

async function upgradeLegacyJournal(
  workspaceRoot: string,
  legacy: LegacyImportPromotionJournal,
  transactionId: string,
): Promise<ImportPromotionJournal> {
  const attachment = await secureReadWorkspaceArtifact(
    workspaceRoot,
    normalizedImportSourcePath(workspaceRoot, legacy.sourcePath),
    { operation: "legacy_attachment_upgrade" },
  );
  const staging = await secureReadWorkspaceArtifact(
    workspaceRoot,
    normalizedImportStagingPath(workspaceRoot, legacy.stagingPath),
    { operation: "legacy_staging_upgrade" },
  );
  if (staging.artifact.sha256 !== legacy.contentHash) {
    throw new Error("Promotion staging artifact does not match its journal hash");
  }
  assertStagingAttachmentBinding(
    workspaceRoot,
    assertApprovedImportFinalNotePath(workspaceRoot, legacy.finalPath),
    staging.contents,
    attachment.artifact.targetPath,
  );
  return {
    version: 2,
    transactionId,
    phase: "prepared",
    attachment: recordArtifact(workspaceRoot, attachment.artifact),
    staging: recordArtifact(workspaceRoot, staging.artifact),
    finalPath: normalizedRelativePath(
      workspaceRoot,
      assertApprovedImportFinalNotePath(workspaceRoot, legacy.finalPath),
    ),
    expectedFinalHash: legacy.contentHash,
    stagingQuarantinePath: normalizedRelativePath(
      workspaceRoot,
      path.join(
        path.dirname(staging.artifact.targetPath),
        `.${path.basename(staging.artifact.targetPath)}.${transactionId}.retired`,
      ),
    ),
  };
}

function parsePromotionJournal(
  raw: string,
): ImportPromotionJournal | LegacyImportPromotionJournal {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error("Invalid import promotion journal");
  }
  if (
    value.version === 1
    && typeof value.sourcePath === "string"
    && typeof value.stagingPath === "string"
    && typeof value.finalPath === "string"
    && isSha256(value.contentHash)
  ) {
    return {
      version: 1,
      sourcePath: value.sourcePath,
      stagingPath: value.stagingPath,
      finalPath: value.finalPath,
      contentHash: value.contentHash,
    };
  }
  if (
    value.version !== 2
    || typeof value.transactionId !== "string"
    || !isPromotionPhase(value.phase)
    || !isRecordedArtifact(value.attachment)
    || !isRecordedArtifact(value.staging)
    || typeof value.finalPath !== "string"
    || !isSha256(value.expectedFinalHash)
    || typeof value.stagingQuarantinePath !== "string"
    || (value.finalTemp !== undefined && !isRecordedArtifact(value.finalTemp))
    || (value.final !== undefined && !isRecordedArtifact(value.final))
  ) {
    throw new Error("Invalid import promotion journal");
  }
  return {
    version: 2,
    transactionId: value.transactionId,
    phase: value.phase,
    attachment: value.attachment,
    staging: value.staging,
    finalPath: value.finalPath,
    expectedFinalHash: value.expectedFinalHash,
    stagingQuarantinePath: value.stagingQuarantinePath,
    ...(value.finalTemp === undefined ? {} : { finalTemp: value.finalTemp }),
    ...(value.final === undefined ? {} : { final: value.final }),
  };
}

function validateJournalForWorkspace(
  workspaceRoot: string,
  journal: ImportPromotionJournal,
): void {
  const attachment = artifactFromRecord(workspaceRoot, journal.attachment);
  const staging = artifactFromRecord(workspaceRoot, journal.staging);
  const finalPath = assertApprovedImportFinalNotePath(
    workspaceRoot,
    journal.finalPath,
  );
  const quarantinePath = assertInsideWorkspace(
    workspaceRoot,
    journal.stagingQuarantinePath,
  );
  if (
    normalizedRelativePath(workspaceRoot, attachment.targetPath)
      !== journal.attachment.path
    || normalizedRelativePath(workspaceRoot, staging.targetPath)
      !== journal.staging.path
    || normalizedRelativePath(workspaceRoot, finalPath) !== journal.finalPath
    || path.dirname(quarantinePath) !== staging.parentPath
    || journal.staging.sha256 !== journal.expectedFinalHash
    || (
      journal.finalTemp !== undefined
      && journal.finalTemp.sha256 !== journal.expectedFinalHash
    )
    || (
      journal.final !== undefined
      && journal.final.sha256 !== journal.expectedFinalHash
    )
  ) {
    throw new Error("Invalid import promotion journal binding");
  }
  if (journal.finalTemp) {
    const finalTemp = artifactFromRecord(workspaceRoot, journal.finalTemp);
    if (finalTemp.parentPath !== path.dirname(finalPath)) {
      throw new Error("Invalid import promotion final temp parent");
    }
  }
  if (journal.final) {
    const final = artifactFromRecord(workspaceRoot, journal.final);
    if (final.targetPath !== finalPath) {
      throw new Error("Invalid import promotion final path");
    }
  }
}

function recordArtifact(
  workspaceRoot: string,
  artifact: SecureWorkspaceArtifactIdentity,
): RecordedArtifact {
  return {
    path: normalizedRelativePath(workspaceRoot, artifact.targetPath),
    parentPath: normalizedRelativePath(workspaceRoot, artifact.parentPath),
    parentRealPath: artifact.parentRealPath,
    parentDev: artifact.parentDev,
    parentIno: artifact.parentIno,
    dev: artifact.fileDev,
    ino: artifact.fileIno,
    sha256: artifact.sha256,
    size: artifact.size,
  };
}

function artifactFromRecord(
  workspaceRoot: string,
  recorded: RecordedArtifact,
): SecureWorkspaceArtifactIdentity {
  return {
    targetPath: assertInsideWorkspace(workspaceRoot, recorded.path),
    parentPath: assertInsideWorkspace(workspaceRoot, recorded.parentPath),
    parentRealPath: recorded.parentRealPath,
    parentDev: recorded.parentDev,
    parentIno: recorded.parentIno,
    fileDev: recorded.dev,
    fileIno: recorded.ino,
    sha256: recorded.sha256,
    size: recorded.size,
  };
}

function assertStagingAttachmentBinding(
  workspaceRoot: string,
  bindingPath: string,
  body: Buffer,
  attachmentPath: string,
): void {
  const document = parseMarkdownDocument(body.toString("utf8"));
  const sourceFile = document.frontmatter.source_file;
  if (typeof sourceFile !== "string" || sourceFile.trim() === "") {
    throw new Error("Promotion staging artifact is missing its attachment binding");
  }
  const boundAttachment = assertInsideWorkspace(
    workspaceRoot,
    path.resolve(path.dirname(bindingPath), sourceFile),
  );
  if (boundAttachment !== attachmentPath) {
    throw new Error(
      `Promotion staging artifact attachment binding changed: ${boundAttachment} != ${attachmentPath}`,
    );
  }
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

function promotionJournalHooks(
  ioHooks: SecureWorkspaceIoHooks | undefined,
  promotionHooks: ImportPromotionHooks | undefined,
): SecureWorkspaceIoHooks {
  return {
    ...(ioHooks?.afterPathSnapshot === undefined
      ? {}
      : { afterPathSnapshot: ioHooks.afterPathSnapshot.bind(ioHooks) }),
    ...(ioHooks?.beforeDestructiveOperation === undefined
      ? {}
      : {
        beforeDestructiveOperation:
          ioHooks.beforeDestructiveOperation.bind(ioHooks),
      }),
    afterWriteChunk: async (operation, tempPath, bytesWritten, totalBytes) => {
      await ioHooks?.afterWriteChunk?.(
        operation,
        tempPath,
        bytesWritten,
        totalBytes,
      );
      if (bytesWritten < totalBytes) {
        await promotionHooks?.afterDurableStep?.("journal_temp_partial");
      }
    },
  };
}

function serializeJournal(journal: ImportPromotionJournal): string {
  return `${JSON.stringify(journal)}\n`;
}

function isJournalTempName(name: string): boolean {
  return name.endsWith(".tmp") || name.includes(".tmp.");
}

function isRecordedArtifact(value: unknown): value is RecordedArtifact {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.parentPath === "string"
    && typeof value.parentRealPath === "string"
    && typeof value.parentDev === "number"
    && typeof value.parentIno === "number"
    && typeof value.dev === "number"
    && typeof value.ino === "number"
    && isSha256(value.sha256)
    && typeof value.size === "number";
}

function isPromotionPhase(value: unknown): value is PromotionPhase {
  return value === "prepared"
    || value === "final_temp_synced"
    || value === "final_published"
    || value === "staging_quarantined"
    || value === "staging_removed";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function fileExistsError(message: string): Error {
  return Object.assign(new Error(message), { code: "EEXIST" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
