export { assertInsideWorkspace, assertRealPathInsideWorkspace } from "./pathGuard";
export {
  assertApprovedImportFinalNotePath,
  evaluateImportSafety,
  fingerprintImportClassification,
} from "./importSafety";
export { detectImportSignals, mergeImportClassification } from "./importClassification";
export { exportLlmsFlat } from "./exporter";
export { importDocumentBatch } from "./imports";
export {
  discardImportPromotionJournal,
  promoteImportArtifact,
  recoverImportPromotions,
} from "./importPromotion";
export { parseFrontmatter } from "./frontmatter";
export { indexWorkspace, workspaceIdForRoot } from "./indexer";
export { parseMarkdownDocument, parseMarkdownNote, serializeMarkdownDocument } from "./markdown";
export { auditWorkspace } from "./workspaceAudit";
export { defaultRoutingPolicy } from "./routingPolicy";
export { importCandidateRoutingPolicy, importCandidateRoutingPrecedence } from "./importCandidateRoutingPolicy";
export { createWorkspace, syncWorkspaceContract } from "./workspace";
export type { NoteFrontmatter } from "./frontmatter";
export type { IndexWorkspaceResult } from "./indexer";
export type { ImportArtifactStatus, ImportBatchInput, ImportFileOps, ImportJob, ImportSourceNote } from "./imports";
export type {
  ImportPromotionHooks,
  ImportPromotionStep,
  PromoteImportArtifactInput,
} from "./importPromotion";
export type { MarkdownDocument, ParsedMarkdownNote } from "./markdown";
export type { WorkspaceAuditFinding, WorkspaceAuditInput, WorkspaceAuditResult, WorkspaceAuditSeverity, WorkspaceAuditStatus } from "./workspaceAudit";
export type { RoutingPolicy } from "./routingPolicy";
export type { ImportCandidateRoutingPrecedence, ImportCandidateRouteInput } from "./importCandidateRoutingPolicy";
export type { SavedImportRule } from "./importClassification";
export type {
  ClassificationSignal,
  ClassificationDiagnostic,
  ContentCategory,
  ImportApprovalProof,
  ImportClassification,
  ImportOperation,
  ImportSensitivity,
  ImportWriteIntent,
  ReviewDecision,
  SafetyDecision,
  SafetyReasonCode,
} from "./importSafety";
export type { WorkspaceInfo } from "./workspace";
export {
  secureCopyFileIntoWorkspace,
  secureEnsureWorkspaceDirectory,
  secureReadWorkspaceDirectory,
  secureReadWorkspaceFile,
  secureReadWorkspaceText,
  secureRewriteWorkspaceFile,
  secureUnlinkWorkspaceFile,
  secureWorkspacePathExists,
  secureWriteWorkspaceFileExclusive,
  syncWorkspaceDirectory,
} from "./secureWorkspaceIo";
export type {
  SecureWorkspaceIoHooks,
  SecureWorkspacePathIdentity,
} from "./secureWorkspaceIo";
