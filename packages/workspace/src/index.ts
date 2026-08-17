export { assertInsideWorkspace, assertRealPathInsideWorkspace } from "./pathGuard";
export {
  assertApprovedImportFinalNotePath,
  evaluateImportSafety,
  fingerprintImportClassification,
} from "./importSafety";
export { detectImportSignals, mergeImportClassification } from "./importClassification";
export {
  activateWorkspaceContentCategory,
  addWorkspaceUserContentCategory,
  builtInContentCategoryCatalog,
  categoryDefinition,
  contentCategoryConfigPath,
  contentCategoryContractDrift,
  createContentCategoryRegistry,
  defaultContentCategoryConfig,
  hiddenBuiltInParentCategoryIds,
  initialActiveBuiltInCategoryIds,
  isContentCategoryId,
  isProtectedContentCategory,
  loadContentCategoryRegistry,
  normalizeContentCategoryId,
  renderContentCategoryContract,
  resolveCategoryDestination,
  serializeContentCategoryConfig,
} from "./contentCategories";
export { exportLlmsFlat } from "./exporter";
export { importDocumentBatch } from "./imports";
export { chunkMarkdownBody } from "./importChunks";
export {
  appendImportedSourceAnnotation,
  assertImportedSourceBodyPreserved,
  importedSourceBodyHash,
  sourceBodyEndMarker,
  sourceBodyStartMarker,
  wrapImportedSourceBody,
} from "./sourceEvidence";
export { normalizeSemanticImportResult } from "./importSemanticEnrichment";
export {
  discardImportPromotionJournal,
  promoteImportArtifact,
  recoverImportPromotions,
} from "./importPromotion";
export { parseFrontmatter } from "./frontmatter";
export { indexWorkspace, workspaceIdForRoot } from "./indexer";
export { shouldWatchWorkspacePath, watchWorkspace, type WorkspaceWatcher } from "./workspaceWatcher";
export { parseMarkdownDocument, parseMarkdownNote, serializeMarkdownDocument } from "./markdown";
export { getOcrRuntimeStatus, type OcrRuntimeStatus } from "./importExtractors";
export { auditWorkspace } from "./workspaceAudit";
export { defaultRoutingPolicy } from "./routingPolicy";
export { importCandidateRoutingPolicy, importCandidateRoutingPrecedence } from "./importCandidateRoutingPolicy";
export {
  createWorkspace,
  syncWorkspaceContract,
  syncWorkspaceContractLocked,
} from "./workspace";
export {
  createWorkspaceWriteLockClient,
  withWorkspaceWriteLock,
  workspaceWriteLockRelativePath,
} from "./workspaceWriteLock";
export type { NoteFrontmatter } from "./frontmatter";
export type { IndexWorkspaceOptions, IndexWorkspaceResult, VectorIndexingStatus, WorkspaceEmbeddingProvider } from "./indexer";
export type { ImportArtifactStatus, ImportBatchInput, ImportFileOps, ImportJob, ImportSourceNote } from "./imports";
export type { ChunkMarkdownOptions, ImportedChunk } from "./importChunks";
export type { ImportedSourceAnnotationInput } from "./sourceEvidence";
export type { SemanticImportEnricher, SemanticImportInput, SemanticImportResult } from "./importSemanticEnrichment";
export type {
  ImportPromotionHooks,
  ImportPromotionResult,
  ImportPromotionStep,
  PromoteImportArtifactInput,
} from "./importPromotion";
export type { MarkdownDocument, ParsedMarkdownNote } from "./markdown";
export type { WorkspaceAuditFinding, WorkspaceAuditInput, WorkspaceAuditResult, WorkspaceAuditSeverity, WorkspaceAuditStatus } from "./workspaceAudit";
export type { RoutingPolicy } from "./routingPolicy";
export type { ImportCandidateRoutingPrecedence, ImportCandidateRouteInput } from "./importCandidateRoutingPolicy";
export type { SavedImportRule } from "./importClassification";
export type {
  ContentCategory,
  ContentCategoryDefinition,
  ContentCategoryRegistry,
  ContentCategoryRisk,
  WorkspaceContentCategoryConfig,
} from "./contentCategories";
export type {
  ClassificationSignal,
  ClassificationDiagnostic,
  ImportApprovalProof,
  ImportClassification,
  ImportOperation,
  ImportSensitivity,
  ImportWriteIntent,
  ReviewDecision,
  SafetyDecision,
  SafetyReasonCode,
} from "./importSafety";
export type {
  WorkspaceContractSyncOptions,
  WorkspaceInfo,
} from "./workspace";
export type {
  WorkspaceWriteLockClient,
  WorkspaceWriteLockOptions,
} from "./workspaceWriteLock";
export {
  secureAtomicReplaceWorkspaceFile,
  secureCopyFileIntoWorkspace,
  secureEnsureWorkspaceDirectory,
  securePublishWorkspaceFileAtomic,
  secureQuarantineWorkspaceArtifact,
  secureReadWorkspaceArtifact,
  secureReadWorkspaceDirectory,
  secureReadWorkspaceFile,
  secureReadWorkspaceText,
  secureRemoveWorkspaceArtifact,
  secureRewriteWorkspaceFile,
  sameArtifactIdentity,
  secureUnlinkWorkspaceFile,
  secureWorkspacePathExists,
  secureWriteWorkspaceFileExclusive,
  syncWorkspaceDirectory,
} from "./secureWorkspaceIo";
export type {
  SecureDestructivePhase,
  SecureWorkspaceArtifactIdentity,
  SecureWorkspaceFileSnapshot,
  SecureWorkspaceIoHooks,
  SecureWorkspacePathIdentity,
} from "./secureWorkspaceIo";
