import { access, readFile } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";
import { defaultRoutingPolicy } from "./routingPolicy";

export interface ProductAuditInput {
  repoRoot: string;
  workspaceRoot: string;
  sourceOverrides?: Map<string, string>;
}

export interface ProductAuditResult {
  passes: string[];
  warnings: string[];
  failures: string[];
}

const routeLiteralPattern = /["'`]((?:04-Resources\/Imports|06-Attachments\/Imports|02-Profiles\/[^"'`]+\/(?:Profile|Memory)\.md|\.vault\/decisions|\.app\/(?:exports|import-staging))[^"'`]*)["'`]/gu;

export async function auditProductContracts(input: ProductAuditInput): Promise<ProductAuditResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const result: ProductAuditResult = { passes: [], warnings: [], failures: [] };
  const workspaceContractSource = await readSource(repoRoot, "packages/workspace/src/templates.ts", input.sourceOverrides);
  const generatedWorkspaceContract = await readGeneratedWorkspaceContract(input.workspaceRoot, result);
  const importSourceNoteRoute = defaultRoutingPolicy.importStagingNotePath(
    "<import-id>",
    "<source-stem>",
  );
  const importAttachmentRoute = `${defaultRoutingPolicy.importAttachmentRoot()}/<import-id>/`;
  const inboxFallbackRoute = `${defaultRoutingPolicy.importInboxDir()}/<import-id>.md`;
  const profileMemoryRoute = "02-Profiles/<profile-id>/Memory.md";
  const profileFinanceRoute = "02-Personal/<profile-id>/Finance/";
  const decisionRoute = ".vault/decisions/<decision-id>.md";

  expectContractText(result, workspaceContractSource, importSourceNoteRoute, "per-source import note");
  expectContractText(result, workspaceContractSource, importAttachmentRoute, "import attachment");
  expectContractText(result, workspaceContractSource, inboxFallbackRoute, "import inbox fallback");
  expectContractText(result, workspaceContractSource, profileMemoryRoute, "profile memory");
  expectContractText(result, workspaceContractSource, profileFinanceRoute, "profile finance");
  expectContractText(result, workspaceContractSource, decisionRoute, "decision");
  auditImportedSourceNoteRouteStatus(workspaceContractSource, result);
  auditImportRoutingPrecedence(workspaceContractSource, result);
  auditImportStagingContract(workspaceContractSource, result);
  if (generatedWorkspaceContract !== undefined) {
    auditGeneratedWorkspaceContract(generatedWorkspaceContract, result);
  }
  if (!result.failures.some((failure) => failure.startsWith("workspace contract is missing"))) {
    result.passes.push("routing policy paths are documented in the workspace contract");
  }

  await auditImportRoutingPolicy(repoRoot, input.sourceOverrides, result);
  await auditImportSafetyKernel(repoRoot, input.sourceOverrides, result);
  if (!result.failures.some((failure) => failure.startsWith("final import writer"))) {
    result.passes.push("final import writes invoke the Safety Kernel");
  }
  await auditInitialImportHardenedIo(
    repoRoot,
    input.sourceOverrides,
    result,
  );
  await auditSecureImportExtraction(repoRoot, input.sourceOverrides, result);
  await auditIdentityBoundRecovery(repoRoot, input.sourceOverrides, result);
  await auditCrossProcessRoutingLock(repoRoot, input.sourceOverrides, result);
  await auditImportStagingExclusion(repoRoot, input.sourceOverrides, result);
  await auditReviewBypassFields(repoRoot, input.sourceOverrides, result);
  await auditFilesystemWriters(repoRoot, input.sourceOverrides, result);
  await auditDecisionMirror(repoRoot, result);
  return result;
}

const importRoutingContractTerms = [
  "Current Review category and destination overrides",
  ".vault/routing-policy.json",
  "Semantic import candidate policy",
  "defaultRoutingPolicy",
  "00-Inbox/Imports/",
  "Saved workspace routing rules never bypass Review.",
];

const importRoutingPolicyTokens = [
  "review_target_override",
  "saved_workspace_routing_rule",
  "semantic_import_candidate_policy",
  "default_routing_policy",
  "inbox_import_fallback",
];

const importedSourceNoteRouteStatusFields = ["route_status", "route_destination"];

function auditImportedSourceNoteRouteStatus(source: string, result: ProductAuditResult): void {
  const missingFields = importedSourceNoteRouteStatusFields.filter((field) => !source.includes(field));
  if (missingFields.length) {
    result.failures.push("workspace contract is missing imported source note route status fields");
    return;
  }
  result.passes.push("imported source note route status is documented in the workspace contract");
}

function auditImportRoutingPrecedence(source: string, result: ProductAuditResult): void {
  const missingTerms = importRoutingContractTerms.filter((term) => !source.includes(term));
  if (missingTerms.length) {
    result.failures.push(`workspace contract is missing import routing precedence terms: ${missingTerms.join(", ")}`);
    return;
  }
  result.passes.push("import routing precedence is documented in the workspace contract");
}

function auditImportStagingContract(source: string, result: ProductAuditResult): void {
  if (documentsObsoletePendingImportRoute(source)) {
    result.failures.push("workspace contract retains obsolete 04-Resources/Imports pending-note route");
    return;
  }
  if (source.includes("Pending import notes are indexed")) {
    result.failures.push("workspace contract documents pending imports as indexed");
    return;
  }
  if (!source.includes("Pending import notes are non-indexed") || !source.includes(".app/import-staging/")) {
    result.failures.push("workspace contract is missing non-indexed import staging contract");
    return;
  }
  result.passes.push("import staging is documented as non-indexed");
}

function auditGeneratedWorkspaceContract(source: string, result: ProductAuditResult): void {
  const missingTerms = importRoutingContractTerms.filter((term) => !source.includes(term));
  if (missingTerms.length) {
    result.failures.push(`generated workspace AGENTS.md is missing import routing precedence terms: ${missingTerms.join(", ")}`);
  }
  if (documentsObsoletePendingImportRoute(source)) {
    result.failures.push("generated workspace AGENTS.md retains obsolete 04-Resources/Imports pending-note route");
  } else if (source.includes("Pending import notes are indexed")) {
    result.failures.push("generated workspace AGENTS.md documents pending imports as indexed");
  } else if (!source.includes("Pending import notes are non-indexed") || !source.includes(".app/import-staging/")) {
    result.failures.push("generated workspace AGENTS.md is missing non-indexed import staging contract");
  }
  if (!source.includes("The Safety Kernel must approve every final import write.")) {
    result.failures.push("generated workspace AGENTS.md is missing the Safety Kernel contract");
  }
  if (!result.failures.some((failure) => failure.startsWith("generated workspace AGENTS.md"))) {
    result.passes.push("generated workspace AGENTS.md matches the import safety contract");
  }
}

function documentsObsoletePendingImportRoute(source: string): boolean {
  return /04-Resources\/Imports\/<(?:batch-name|import-id)>\/<source-stem>\.md\\?` while pending Review/u
    .test(source);
}

async function auditImportRoutingPolicy(repoRoot: string, sourceOverrides: Map<string, string> | undefined, result: ProductAuditResult): Promise<void> {
  const source = await readSource(repoRoot, "packages/workspace/src/importCandidateRoutingPolicy.ts", sourceOverrides);
  const missingTokens = importRoutingPolicyTokens.filter((token) => !source.includes(token));
  if (missingTokens.length) {
    result.failures.push(`import candidate routing policy is missing precedence tokens: ${missingTokens.join(", ")}`);
    return;
  }
  result.passes.push("import candidate routing precedence is implemented");
}

async function auditImportSafetyKernel(repoRoot: string, sourceOverrides: Map<string, string> | undefined, result: ProductAuditResult): Promise<void> {
  const importerPath = "packages/workspace/src/imports.ts";
  const reviewPath = "apps/desktop/electron/ipc.ts";
  const importerSource = await readSource(repoRoot, importerPath, sourceOverrides);
  const reviewSource = await readSource(repoRoot, reviewPath, sourceOverrides);

  auditImporterSafetyKernel(importerPath, importerSource, result);
  auditReviewSafetyKernel(reviewPath, reviewSource, result);
}

async function auditInitialImportHardenedIo(
  repoRoot: string,
  sourceOverrides: Map<string, string> | undefined,
  result: ProductAuditResult,
): Promise<void> {
  const importerPath = "packages/workspace/src/imports.ts";
  const promotionPath = "packages/workspace/src/importPromotion.ts";
  const secureIoPath = "packages/workspace/src/secureWorkspaceIo.ts";
  let importerSource: string;
  let promotionSource: string;
  let secureIoSource: string;
  try {
    [importerSource, promotionSource, secureIoSource] = await Promise.all([
      readSource(repoRoot, importerPath, sourceOverrides),
      readSource(repoRoot, promotionPath, sourceOverrides),
      readSource(repoRoot, secureIoPath, sourceOverrides),
    ]);
  } catch {
    result.failures.push("initial import hardened IO sources cannot be read");
    return;
  }
  const importerFile = ts.createSourceFile(
    importerPath,
    importerSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const promotionFile = ts.createSourceFile(
    promotionPath,
    promotionSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const secureIoFile = ts.createSourceFile(
    secureIoPath,
    secureIoSource,
    ts.ScriptTarget.Latest,
    true,
  );

  const importBatch = namedFunction(importerFile, "importDocumentBatch");
  const persistSource = namedFunction(importerFile, "persistSourceNote");
  const publishFinal = namedFunction(promotionFile, "publishFinal");
  const publishRecoveredFinal = namedFunction(
    promotionFile,
    "publishRecoveredFinal",
  );
  const createJournal = namedFunction(
    promotionFile,
    "createPromotionJournal",
  );
  const persistJournal = namedFunction(promotionFile, "persistJournal");
  const attachmentIsHardened = importsNamedBinding(
    importerFile,
    "./secureWorkspaceIo",
    "secureCopyFileIntoWorkspace",
  ) && hasCallWithOperation(
    importBatch,
    "secureCopyFileIntoWorkspace",
    "attachment_create",
  );
  const stagingIsHardened = importsNamedBinding(
    importerFile,
    "./secureWorkspaceIo",
    "secureWriteWorkspaceFileExclusive",
  ) && hasCallWithOperation(
    persistSource,
    "secureWriteWorkspaceFileExclusive",
    "staging_create",
  );
  const finalIsHardened = importsNamedBinding(
    importerFile,
    "./importPromotion",
    "promoteImportArtifact",
  ) && hasDirectCall(persistSource, "promoteImportArtifact")
    && importsNamedBinding(
      promotionFile,
      "./secureWorkspaceIo",
      "securePublishWorkspaceFileAtomic",
    )
    && hasCallWithOperation(
      publishFinal,
      "securePublishWorkspaceFileAtomic",
      "final_create",
    )
    && hasCallWithOperation(
      publishRecoveredFinal,
      "securePublishWorkspaceFileAtomic",
      "final_recover_create",
    )
    && hasCallWithOperation(
      createJournal,
      "secureAtomicReplaceWorkspaceFile",
      "journal_create",
    )
    && hasCallWithOperation(
      persistJournal,
      "secureAtomicReplaceWorkspaceFile",
      "journal_update",
    );

  if (!attachmentIsHardened) {
    result.failures.push(
      `initial import attachment write bypasses hardened workspace IO: ${importerPath}`,
    );
  }
  if (!stagingIsHardened) {
    result.failures.push(
      `initial import staging write bypasses hardened workspace IO: ${importerPath}`,
    );
  }
  if (!finalIsHardened) {
    result.failures.push(
      `initial import final write bypasses hardened workspace IO: ${promotionPath}`,
    );
  }
  if (!isHardenedWorkspaceIoImplementation(secureIoFile)) {
    result.failures.push(
      `hardened workspace IO is missing real-path, ancestor, inode, or exclusive-open checks: ${secureIoPath}`,
    );
  }
  if (!isAtomicWorkspacePublicationImplementation(secureIoFile)) {
    result.failures.push(
      `atomic workspace publication is missing verified temp, sync, publish, or identity-bound cleanup calls: ${secureIoPath}`,
    );
  }
  if (
    attachmentIsHardened
    && stagingIsHardened
    && finalIsHardened
    && isHardenedWorkspaceIoImplementation(secureIoFile)
    && isAtomicWorkspacePublicationImplementation(secureIoFile)
  ) {
    result.passes.push(
      "initial import attachment, staging, journal, and final writes use hardened workspace IO",
    );
  }
}

async function auditSecureImportExtraction(
  repoRoot: string,
  sourceOverrides: Map<string, string> | undefined,
  result: ProductAuditResult,
): Promise<void> {
  const importerPath = "packages/workspace/src/imports.ts";
  const extractorPath = "packages/workspace/src/importExtractors.ts";
  const secureIoPath = "packages/workspace/src/secureWorkspaceIo.ts";
  const [importerSource, extractorSource, secureIoSource] = await Promise.all([
    readSource(repoRoot, importerPath, sourceOverrides),
    readSource(repoRoot, extractorPath, sourceOverrides),
    readSource(repoRoot, secureIoPath, sourceOverrides),
  ]);
  const importerFile = sourceFileFor(importerPath, importerSource);
  const extractorFile = sourceFileFor(extractorPath, extractorSource);
  const secureIoFile = sourceFileFor(secureIoPath, secureIoSource);
  const importBatch = namedFunction(importerFile, "importDocumentBatch");
  const extractor = namedFunction(extractorFile, "extractDocumentText");
  const secureCopy = namedFunction(
    secureIoFile,
    "secureCopyFileIntoWorkspace",
  );
  const extractionCalls = directCallsNamed(importBatch, "extractDocumentText");
  const consumesVerifiedCopy = extractionCalls.length > 0
    && extractionCalls.every((call) => argumentIsPropertyOfCallResult(
      importBatch,
      call.arguments[1],
      "contents",
      "secureCopyFileIntoWorkspace",
    ));
  const extractorUsesBuffer = extractor !== undefined
    && parameterHasType(extractor, 1, "Buffer")
    && hasPropertyCallOnParameter(extractor, 1, "toString")
    && !hasDirectCall(extractor, "readFile")
    && !importsNamedBinding(
      extractorFile,
      "node:fs/promises",
      "readFile",
    );
  const copiedArtifactIsReopened = secureCopy !== undefined
    && hasCallWithObjectProperty(
      secureCopy,
      "secureReadWorkspaceArtifact",
      "expectedArtifact",
    )
    && hasCallWithOperation(
      secureCopy,
      "secureReadWorkspaceArtifact",
      "attachment_verify",
    );

  if (
    !consumesVerifiedCopy
    || !extractorUsesBuffer
    || !copiedArtifactIsReopened
  ) {
    result.failures.push(
      "secure import extraction does not consume identity-verified copied attachment bytes",
    );
    return;
  }
  result.passes.push(
    "secure import extraction consumes identity-verified copied attachment bytes",
  );
}

async function auditIdentityBoundRecovery(
  repoRoot: string,
  sourceOverrides: Map<string, string> | undefined,
  result: ProductAuditResult,
): Promise<void> {
  const importerPath = "packages/workspace/src/imports.ts";
  const promotionPath = "packages/workspace/src/importPromotion.ts";
  const reviewPath = "apps/desktop/electron/ipc.ts";
  const secureIoPath = "packages/workspace/src/secureWorkspaceIo.ts";
  const [importerSource, promotionSource, reviewSource, secureIoSource] =
    await Promise.all([
      readSource(repoRoot, importerPath, sourceOverrides),
      readSource(repoRoot, promotionPath, sourceOverrides),
      readSource(repoRoot, reviewPath, sourceOverrides),
      readSource(repoRoot, secureIoPath, sourceOverrides),
    ]);
  const importerFile = sourceFileFor(importerPath, importerSource);
  const promotionFile = sourceFileFor(promotionPath, promotionSource);
  const reviewFile = sourceFileFor(reviewPath, reviewSource);
  const secureIoFile = sourceFileFor(secureIoPath, secureIoSource);

  const batchCleanup = namedFunction(importerFile, "cleanupCreatedArtifacts");
  const retireStaging = namedFunction(promotionFile, "retireStaging");
  const rollbackFinal = namedFunction(
    promotionFile,
    "rollbackPublishedFinal",
  );
  const removeRecorded = namedFunction(
    promotionFile,
    "removeRecordedIfOwned",
  );
  const reviewMove = namedFunction(reviewFile, "moveImportedSourceNote");
  const persistedReview = namedFunction(
    reviewFile,
    "reconcilePersistedImportedApplication",
  );
  const secureRemove = namedFunction(
    secureIoFile,
    "secureRemoveWorkspaceArtifact",
  );

  const batchIsIdentityBound = hasCallWithIdentifierArgument(
    batchCleanup,
    "secureRemoveWorkspaceArtifact",
    1,
    "artifact",
  );
  const promotionIsIdentityBound = hasCallWithOperation(
    retireStaging,
    "secureRemoveWorkspaceArtifact",
    "staging_retire",
  )
    && hasDirectCall(rollbackFinal, "removeRecordedIfOwned")
    && hasCallWithIdentifierArgument(
      removeRecorded,
      "secureRemoveWorkspaceArtifact",
      1,
      "artifact",
    );
  const reviewIsIdentityBound = hasCallWithOperation(
    reviewMove,
    "secureRemoveWorkspaceArtifact",
    "staging_retire",
  )
    && hasCallWithOperation(
      reviewMove,
      "secureRemoveWorkspaceArtifact",
      "destination_rollback",
    )
    && hasCallWithOperation(
      persistedReview,
      "secureRemoveWorkspaceArtifact",
      "persisted_staging_retire",
    );
  const removalQuarantinesBeforeDelete = hasDirectCalls(secureRemove, [
    "secureReadWorkspaceArtifact",
    "rename",
    "syncWorkspaceDirectory",
    "sameFileArtifact",
    "revalidateOriginalParent",
  ]) && callsOccurInOrder(secureRemove, [
    "secureReadWorkspaceArtifact",
    "rename",
    "sameFileArtifact",
    "revalidateOriginalParent",
  ]);

  if (
    !batchIsIdentityBound
    || !promotionIsIdentityBound
    || !reviewIsIdentityBound
    || !removalQuarantinesBeforeDelete
  ) {
    result.failures.push(
      "import rollback and retirement cleanup are not identity-bound quarantine operations",
    );
    return;
  }
  result.passes.push(
    "import rollback and retirement cleanup are identity-bound quarantine operations",
  );
}

async function auditCrossProcessRoutingLock(
  repoRoot: string,
  sourceOverrides: Map<string, string> | undefined,
  result: ProductAuditResult,
): Promise<void> {
  const reviewPath = "apps/desktop/electron/ipc.ts";
  const lockPath = "packages/workspace/src/workspaceWriteLock.ts";
  const [reviewSource, lockSource] = await Promise.all([
    readSource(repoRoot, reviewPath, sourceOverrides),
    readSource(repoRoot, lockPath, sourceOverrides),
  ]);
  const reviewFile = sourceFileFor(reviewPath, reviewSource);
  const lockFile = sourceFileFor(lockPath, lockSource);
  const saveRule = namedFunction(reviewFile, "saveUserRoutingRule");
  const appendPolicy = namedFunction(reviewFile, "appendRoutingPolicyRule");
  const syncAgents = namedFunction(reviewFile, "syncAgentsRoutingRules");
  const activateWorkspace = namedFunction(reviewFile, "activateWorkspace");
  const acquireLock = namedFunction(lockFile, "acquireFilesystemLock");
  const holdLock = namedFunction(lockFile, "withFilesystemLock");
  const withLockMethod = namedMethod(lockFile, "withLock");
  const lockCall = directCallsNamed(saveRule, "withWorkspaceWriteLock")[0];

  const lockEnclosesRoutingWrites = lockCall !== undefined
    && callbackArgumentCalls(lockCall, 1, [
      "appendRoutingPolicyRule",
      "syncAgentsRoutingRules",
      "writeRoutingRuleAdr",
    ]);
  const routingWritesAreAtomic = hasDirectCall(
    appendPolicy,
    "secureAtomicReplaceWorkspaceFile",
  ) && hasDirectCall(syncAgents, "secureAtomicReplaceWorkspaceFile");
  const workspaceIsCanonical = hasDirectCall(
    activateWorkspace,
    "realpath",
  ) && hasDirectCallLike(withLockMethod, "realpath");
  const lockIsFilesystemBacked = hasDirectCalls(acquireLock, [
    "secureWriteWorkspaceFileExclusive",
    "syncWorkspaceDirectory",
    "readContendedLock",
    "secureRemoveWorkspaceArtifact",
  ])
    && hasDirectCall(holdLock, "secureRemoveWorkspaceArtifact")
    && functionContainsObjectProperties(acquireLock, [
      "token",
      "pid",
      "createdAt",
      "leaseUntil",
    ])
    && functionContainsIdentifier(acquireLock, "deadline")
    && acquireLock !== undefined
    && nodesInFunction(acquireLock).some(ts.isWhileStatement);

  if (
    !importsNamedBinding(
      reviewFile,
      "@kb-agent/workspace",
      "withWorkspaceWriteLock",
    )
    || !lockEnclosesRoutingWrites
    || !routingWritesAreAtomic
    || !workspaceIsCanonical
    || !lockIsFilesystemBacked
  ) {
    result.failures.push(
      "routing policy and AGENTS updates are not protected by the canonical cross-process workspace lock",
    );
    return;
  }
  result.passes.push(
    "routing policy and AGENTS updates use the canonical cross-process workspace lock",
  );
}

function isAtomicWorkspacePublicationImplementation(
  sourceFile: ts.SourceFile,
): boolean {
  const publish = namedFunction(
    sourceFile,
    "securePublishWorkspaceFileAtomic",
  );
  const replace = namedFunction(
    sourceFile,
    "secureAtomicReplaceWorkspaceFile",
  );
  const writeTemp = namedFunction(sourceFile, "writeAtomicTemp");
  return hasDirectCalls(publish, [
    "writeAtomicTemp",
    "link",
    "syncWorkspaceDirectory",
    "secureReadWorkspaceArtifact",
    "secureRemoveWorkspaceArtifact",
  ])
    && callsOccurInOrder(publish, [
      "writeAtomicTemp",
      "link",
      "syncWorkspaceDirectory",
      "secureReadWorkspaceArtifact",
      "secureRemoveWorkspaceArtifact",
    ])
    && hasDirectCalls(replace, [
      "writeAtomicTemp",
      "rename",
      "syncWorkspaceDirectory",
      "secureReadWorkspaceArtifact",
    ])
    && callsOccurInOrder(replace, [
      "writeAtomicTemp",
      "rename",
      "syncWorkspaceDirectory",
      "secureReadWorkspaceArtifact",
    ])
    && hasDirectCall(writeTemp, "secureWriteWorkspaceFileExclusive");
}

function isHardenedWorkspaceIoImplementation(
  sourceFile: ts.SourceFile,
): boolean {
  const writer = namedFunction(
    sourceFile,
    "secureWriteWorkspaceFileExclusive",
  );
  const capture = namedFunction(sourceFile, "capturePathIdentity");
  const revalidate = namedFunction(sourceFile, "revalidatePathIdentity");
  const noFollow = namedFunction(sourceFile, "noFollowFlag");
  return hasDirectCalls(writer, [
    "capturePathIdentity",
    "revalidatePathIdentity",
    "open",
    "noFollowFlag",
  ])
    && functionContainsProperty(writer, "constants", "O_EXCL")
    && hasDirectCalls(capture, [
      "assertNoSymlinkAncestors",
      "lstat",
      "realpath",
    ])
    && hasDirectCalls(revalidate, [
      "assertNoSymlinkAncestors",
      "lstat",
      "realpath",
    ])
    && functionContainsProperty(capture, "parent", "dev")
    && functionContainsProperty(capture, "parent", "ino")
    && functionContainsProperty(noFollow, "constants", "O_NOFOLLOW");
}

function namedFunction(
  sourceFile: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | undefined {
  return functionDeclarations(sourceFile).find(
    (declaration) => declaration.name?.text === name,
  );
}

function namedMethod(
  sourceFile: ts.SourceFile,
  name: string,
): ts.MethodDeclaration | undefined {
  return nodesInSourceFile(sourceFile).find(
    (node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name,
  );
}

function sourceFileFor(relativePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
}

function directCallsNamed(
  declaration: ts.FunctionDeclaration | undefined,
  callName: string,
): ts.CallExpression[] {
  return declaration === undefined
    ? []
    : nodesInFunction(declaration).filter(
      (node): node is ts.CallExpression => ts.isCallExpression(node)
        && calledName(node) === callName,
    );
}

function argumentIsPropertyOfCallResult(
  declaration: ts.FunctionDeclaration | undefined,
  argument: ts.Expression | undefined,
  propertyName: string,
  callName: string,
): boolean {
  if (
    declaration === undefined
    || argument === undefined
    || !ts.isPropertyAccessExpression(argument)
    || argument.name.text !== propertyName
    || !ts.isIdentifier(argument.expression)
  ) {
    return false;
  }
  const binding = resolvesToBinding(declaration, argument.expression);
  return binding !== undefined
    && ts.isVariableDeclaration(binding)
    && calledNameFromInitializer(binding.initializer) === callName;
}

function calledNameFromInitializer(
  initializer: ts.Expression | undefined,
): string | undefined {
  let expression = initializer;
  while (
    expression !== undefined
    && (
      ts.isAwaitExpression(expression)
      || ts.isParenthesizedExpression(expression)
    )
  ) {
    expression = expression.expression;
  }
  return expression !== undefined && ts.isCallExpression(expression)
    ? calledName(expression)
    : undefined;
}

function parameterHasType(
  declaration: ts.FunctionDeclaration,
  parameterIndex: number,
  typeName: string,
): boolean {
  const parameter = declaration.parameters[parameterIndex];
  return parameter?.type !== undefined
    && ts.isTypeReferenceNode(parameter.type)
    && ts.isIdentifier(parameter.type.typeName)
    && parameter.type.typeName.text === typeName;
}

function hasPropertyCallOnParameter(
  declaration: ts.FunctionDeclaration,
  parameterIndex: number,
  propertyName: string,
): boolean {
  const parameter = declaration.parameters[parameterIndex];
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) {
    return false;
  }
  const parameterName = parameter.name.text;
  return nodesInFunction(declaration).some(
    (node) => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === parameterName
      && node.expression.name.text === propertyName,
  );
}

function hasCallWithObjectProperty(
  declaration: ts.FunctionDeclaration | undefined,
  callName: string,
  propertyName: string,
): boolean {
  return directCallsNamed(declaration, callName).some((call) =>
    call.arguments.some((argument) => nodesInNode(argument).some(
      (node) => ts.isPropertyAssignment(node)
        && propertyNameText(node.name) === propertyName,
    )));
}

function hasCallWithIdentifierArgument(
  declaration: ts.FunctionDeclaration | undefined,
  callName: string,
  argumentIndex: number,
  identifierName: string,
): boolean {
  return directCallsNamed(declaration, callName).some(
    (call) => isIdentifierNamed(call.arguments[argumentIndex], identifierName),
  );
}

function callsOccurInOrder(
  declaration: ts.FunctionDeclaration | undefined,
  callNames: string[],
): boolean {
  if (declaration === undefined) {
    return false;
  }
  const calls = nodesInFunction(declaration)
    .filter((node): node is ts.CallExpression => ts.isCallExpression(node))
    .map((call) => ({ name: calledName(call), position: call.pos }));
  let previousPosition = -1;
  for (const callName of callNames) {
    const match = calls.find(
      (call) => call.name === callName && call.position > previousPosition,
    );
    if (!match) {
      return false;
    }
    previousPosition = match.position;
  }
  return true;
}

function callbackArgumentCalls(
  call: ts.CallExpression,
  argumentIndex: number,
  callNames: string[],
): boolean {
  const callback = call.arguments[argumentIndex];
  if (
    callback === undefined
    || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
  ) {
    return false;
  }
  const called = new Set(
    nodesInNode(callback.body)
      .filter((node): node is ts.CallExpression => ts.isCallExpression(node))
      .map(calledName)
      .filter((name): name is string => name !== undefined),
  );
  return callNames.every((callName) => called.has(callName));
}

function functionContainsObjectProperties(
  declaration: ts.FunctionDeclaration | undefined,
  propertyNames: string[],
): boolean {
  if (declaration === undefined) {
    return false;
  }
  const present = new Set(
    nodesInFunction(declaration).flatMap((node) => {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        return [propertyNameText(node.name)];
      }
      return [];
    }),
  );
  return propertyNames.every((propertyName) => present.has(propertyName));
}

function functionContainsIdentifier(
  declaration: ts.FunctionDeclaration | undefined,
  identifierName: string,
): boolean {
  return declaration !== undefined
    && nodesInFunction(declaration).some(
      (node) => ts.isIdentifier(node) && node.text === identifierName,
    );
}

function hasDirectCallLike(
  declaration: ts.MethodDeclaration | undefined,
  callName: string,
): boolean {
  return declaration !== undefined
    && nodesInNode(declaration).some(
      (node) => ts.isCallExpression(node) && calledName(node) === callName,
    );
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name)
    || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name)
    || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined;
}

function nodesInNode(root: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
}

function hasDirectCall(
  declaration: ts.FunctionDeclaration | undefined,
  callName: string,
): boolean {
  return declaration !== undefined
    && nodesInFunction(declaration).some(
      (node) => ts.isCallExpression(node) && calledName(node) === callName,
    );
}

function hasDirectCalls(
  declaration: ts.FunctionDeclaration | undefined,
  callNames: string[],
): boolean {
  return callNames.every((callName) => hasDirectCall(declaration, callName));
}

function hasCallWithOperation(
  declaration: ts.FunctionDeclaration | undefined,
  callName: string,
  operation: string,
): boolean {
  return declaration !== undefined
    && nodesInFunction(declaration).some(
      (node) => ts.isCallExpression(node)
        && calledName(node) === callName
        && node.arguments.some((argument) => nodeContainsString(argument, operation)),
    );
}

function nodeContainsString(node: ts.Node, value: string): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (
      (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
      && current.text === value
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function functionContainsProperty(
  declaration: ts.FunctionDeclaration | undefined,
  receiver: string,
  property: string,
): boolean {
  return declaration !== undefined
    && nodesInFunction(declaration).some(
      (node) => ts.isPropertyAccessExpression(node)
        && isIdentifierNamed(node.expression, receiver)
        && node.name.text === property,
    );
}

// These checks accept only explicit Safety Kernel control-flow shapes around final writes.
// They cannot prove behavior through dynamic dispatch, runtime code generation, or aliased module imports.
function auditImporterSafetyKernel(relativePath: string, source: string, result: ProductAuditResult): void {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  if (!importsNamedBinding(sourceFile, "./importSafety", "evaluateImportSafety")) {
    result.failures.push(`final import writer does not import the Safety Kernel: ${relativePath}`);
    return;
  }

  const promotionWriters = writerFunctions(sourceFile, isFinalImportPromotionWrite);
  if (!promotionWriters.length || !promotionWriters.every(({ declaration }) => safetyDecisionBinding(declaration) !== undefined)) {
    result.failures.push(`final import writer does not call the Safety Kernel: ${relativePath}`);
    return;
  }
  if (!promotionWriters.every(({ declaration, writes }) => {
    const binding = safetyDecisionBinding(declaration);
    return binding !== undefined && writes.every((write) => hasAcceptedAutoWriteShape(declaration, write, binding));
  })) {
    result.failures.push(`final import writer is not gated on Safety Kernel auto_write: ${relativePath}`);
    return;
  }
  result.passes.push(`final import writer is Safety Kernel-gated: ${relativePath}`);
}

function auditReviewSafetyKernel(relativePath: string, source: string, result: ProductAuditResult): void {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  if (!importsNamedBinding(sourceFile, "@kb-agent/workspace", "evaluateImportSafety")) {
    result.failures.push(`final import writer does not import the Safety Kernel: ${relativePath}`);
    return;
  }

  const reviewWriters = writerFunctions(sourceFile, isReviewImportPromotionWrite);
  if (!reviewWriters.length || !reviewWriters.every(({ declaration }) => safetyDecisionBinding(declaration) !== undefined)) {
    result.failures.push(`final import writer does not call the Safety Kernel: ${relativePath}`);
    return;
  }
  if (!reviewWriters.every(({ declaration, writes }) => {
    const binding = safetyDecisionBinding(declaration);
    return binding !== undefined && writes.every((write) => hasAcceptedAutoWriteShape(declaration, write, binding));
  })) {
    result.failures.push(`final import writer is not gated on Safety Kernel auto_write: ${relativePath}`);
    return;
  }
  result.passes.push(`final import writer is Safety Kernel-gated: ${relativePath}`);
}

function importsNamedBinding(sourceFile: ts.SourceFile, moduleSpecifier: string, bindingName: string): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleSpecifier) {
      return false;
    }
    const namedBindings = statement.importClause?.namedBindings;
    return namedBindings !== undefined
      && ts.isNamedImports(namedBindings)
      && namedBindings.elements.some((element) => element.name.text === bindingName || element.propertyName?.text === bindingName);
  });
}

function safetyDecisionBinding(declaration: ts.FunctionDeclaration): ts.VariableDeclaration | undefined {
  return nodesInFunction(declaration).find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && isDirectSafetyKernelCall(node.initializer));
}

function isDirectSafetyKernelCall(initializer: ts.Expression | undefined): boolean {
  const expression = initializer !== undefined && ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
  return expression !== undefined && ts.isCallExpression(expression) && calledName(expression) === "evaluateImportSafety";
}

function hasAcceptedAutoWriteShape(declaration: ts.FunctionDeclaration, finalWrite: ts.CallExpression, binding: ts.VariableDeclaration): boolean {
  return isInsideAutoWriteBranch(declaration, finalWrite, binding) || isAfterTerminatingAutoWriteGuard(declaration, finalWrite, binding);
}

function isInsideAutoWriteBranch(declaration: ts.FunctionDeclaration, finalWrite: ts.CallExpression, binding: ts.VariableDeclaration): boolean {
  let current: ts.Node | undefined = finalWrite;
  while (current !== undefined && current !== declaration) {
    const parent: ts.Node = current.parent;
    if (ts.isIfStatement(parent)
      && parent.thenStatement === current
      && isExactSafetyDecisionComparison(declaration, parent.expression, ts.SyntaxKind.EqualsEqualsEqualsToken, binding)) {
      return true;
    }
    current = parent;
  }
  return false;
}

function isAfterTerminatingAutoWriteGuard(declaration: ts.FunctionDeclaration, finalWrite: ts.CallExpression, binding: ts.VariableDeclaration): boolean {
  let current: ts.Node | undefined = finalWrite;
  while (current !== undefined && current !== declaration) {
    const block = current.parent;
    if (ts.isBlock(block) && ts.isStatement(current)) {
      const statementIndex = block.statements.indexOf(current);
      if (block.statements.slice(0, statementIndex).some((statement) => ts.isIfStatement(statement)
        && isExactSafetyDecisionComparison(declaration, statement.expression, ts.SyntaxKind.ExclamationEqualsEqualsToken, binding)
        && terminatesDirectly(statement.thenStatement))) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isExactSafetyDecisionComparison(
  declaration: ts.FunctionDeclaration,
  expression: ts.Expression,
  operator: ts.SyntaxKind,
  binding: ts.VariableDeclaration,
): boolean {
  return ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === operator
    && ts.isPropertyAccessExpression(expression.left)
    && ts.isIdentifier(expression.left.expression)
    && resolvesToSafetyBinding(declaration, expression.left.expression, binding)
    && expression.left.name.text === "decision"
    && ts.isStringLiteral(expression.right)
    && expression.right.text === "auto_write";
}

type LexicalDeclaration = ts.VariableDeclaration | ts.ParameterDeclaration;

interface LexicalBinding {
  declaration: LexicalDeclaration;
  identifier: ts.Identifier;
  scope: ts.Node;
}

function resolvesToBinding(declaration: ts.FunctionDeclaration, reference: ts.Identifier): LexicalDeclaration | undefined {
  return lexicalBindings(declaration)
    .filter((binding) => binding.identifier.text === reference.text
      && binding.identifier.pos < reference.pos
      && nodeIsInside(reference, binding.scope))
    .sort((left, right) => {
      const depthDifference = scopeDepth(right.scope) - scopeDepth(left.scope);
      return depthDifference !== 0 ? depthDifference : right.identifier.pos - left.identifier.pos;
    })[0]?.declaration;
}

function resolvesToSafetyBinding(
  declaration: ts.FunctionDeclaration,
  reference: ts.Identifier,
  kernelDeclaration: ts.VariableDeclaration,
): boolean {
  const resolved = resolvesToBinding(declaration, reference);
  const resolvesToKernel = resolved === kernelDeclaration
    || (resolved !== undefined
      && ts.isVariableDeclaration(resolved)
      && isSameFunctionScopedVarBinding(declaration, resolved, kernelDeclaration, reference.text));
  return resolvesToKernel
    && (!isFunctionScopedVar(kernelDeclaration)
      || isSoleInitializedVarDeclaration(declaration, reference, kernelDeclaration));
}

function isSameFunctionScopedVarBinding(
  declaration: ts.FunctionDeclaration,
  candidate: ts.VariableDeclaration,
  kernelDeclaration: ts.VariableDeclaration,
  bindingName: string,
): boolean {
  return ts.isIdentifier(kernelDeclaration.name)
    && kernelDeclaration.name.text === bindingName
    && bindingIdentifiers(candidate.name).some((identifier) => identifier.text === bindingName)
    && isFunctionScopedVar(candidate)
    && isFunctionScopedVar(kernelDeclaration)
    && declarationScope(candidate, declaration) === declarationScope(kernelDeclaration, declaration);
}

function isSoleInitializedVarDeclaration(
  declaration: ts.FunctionDeclaration,
  reference: ts.Identifier,
  kernelDeclaration: ts.VariableDeclaration,
): boolean {
  const initializedDeclarations = nodesInFunction(declaration).filter((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
    && node.initializer !== undefined
    && isSameFunctionScopedVarBinding(declaration, node, kernelDeclaration, reference.text));
  return initializedDeclarations.length === 1 && initializedDeclarations[0] === kernelDeclaration;
}

function lexicalBindings(declaration: ts.FunctionDeclaration): LexicalBinding[] {
  return nodesInFunction(declaration).flatMap((node): LexicalBinding[] => {
    if (!ts.isVariableDeclaration(node) && !ts.isParameter(node)) {
      return [];
    }
    const scope = declarationScope(node, declaration);
    return bindingIdentifiers(node.name).map((identifier) => ({ declaration: node, identifier, scope }));
  });
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}

function declarationScope(binding: LexicalDeclaration, declaration: ts.FunctionDeclaration): ts.Node {
  if (ts.isParameter(binding)) {
    return declaration;
  }
  if (ts.isCatchClause(binding.parent)) {
    return binding.parent.block;
  }
  if (!isBlockScopedVariable(binding)) {
    return declaration;
  }

  let current: ts.Node | undefined = binding.parent;
  while (current !== undefined && current !== declaration) {
    if (ts.isBlock(current)
      || ts.isCaseBlock(current)
      || ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)) {
      return current;
    }
    current = current.parent;
  }
  return declaration;
}

function isBlockScopedVariable(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
}

function isFunctionScopedVar(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.BlockScoped) === 0;
}

function nodeIsInside(node: ts.Node, container: ts.Node): boolean {
  return container.pos <= node.pos && node.end <= container.end;
}

function scopeDepth(node: ts.Node): number {
  let depth = 0;
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

function terminatesDirectly(statement: ts.Statement): boolean {
  if (ts.isThrowStatement(statement) || ts.isReturnStatement(statement)) {
    return true;
  }
  return ts.isBlock(statement)
    && statement.statements.length > 0
    && statement.statements.every((child) => ts.isThrowStatement(child) || ts.isReturnStatement(child));
}

function isFinalImportPromotionWrite(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && (
      calledName(node) === "promoteImportArtifact"
      || (
        isMethodCall(node, "fileOps", "writeFile")
        && node.arguments[0] !== undefined
        && ts.isIdentifier(node.arguments[0])
        && node.arguments[0].text === "finalTargetPath"
        && isAwaitedMethodCall(node.arguments[1], "fileOps", "readFile", "stagingTargetPath")
        && node.arguments[2]?.kind === ts.SyntaxKind.TrueKeyword
      )
    );
}

function isReviewImportPromotionWrite(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "securePublishWorkspaceFileAtomic"
    && node.arguments.length >= 4
    && isIdentifierNamed(node.arguments[0], "workspaceRoot")
    && isIdentifierNamed(node.arguments[1], "approvedDestinationPath")
    && isIdentifierNamed(node.arguments[2], "approvedBody")
    && nodeContainsString(node.arguments[3]!, "destination_create");
}

function isMethodCall(node: ts.CallExpression, receiver: string, method: string): boolean {
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === receiver
    && node.expression.name.text === method;
}

function isAwaitedMethodCall(node: ts.Expression | undefined, receiver: string, method: string, argument: string): boolean {
  return node !== undefined
    && ts.isAwaitExpression(node)
    && ts.isCallExpression(node.expression)
    && isMethodCall(node.expression, receiver, method)
    && isIdentifierNamed(node.expression.arguments[0], argument);
}

function isIdentifierNamed(node: ts.Node | undefined, name: string): boolean {
  return node !== undefined && ts.isIdentifier(node) && node.text === name;
}

function isPropertyAccessNamed(node: ts.Node | undefined, receiver: string, property: string): boolean {
  return node !== undefined
    && ts.isPropertyAccessExpression(node)
    && isIdentifierNamed(node.expression, receiver)
    && node.name.text === property;
}

function calledName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  return ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
}

function functionDeclarations(sourceFile: ts.SourceFile): ts.FunctionDeclaration[] {
  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function writerFunctions(
  sourceFile: ts.SourceFile,
  selector: (node: ts.Node) => boolean,
): Array<{ declaration: ts.FunctionDeclaration; writes: ts.CallExpression[] }> {
  return functionDeclarations(sourceFile)
    .map((declaration) => ({ declaration, writes: finalWriterCalls(declaration, selector) }))
    .filter(({ writes }) => writes.length > 0);
}

function finalWriterCalls(declaration: ts.FunctionDeclaration, selector: (node: ts.Node) => boolean): ts.CallExpression[] {
  return nodesInFunction(declaration).filter((node): node is ts.CallExpression => ts.isCallExpression(node) && selector(node));
}

function nodesInFunction(functionDeclaration: ts.FunctionDeclaration): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    if (node !== functionDeclaration && ts.isFunctionLike(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(functionDeclaration);
  return nodes;
}

function expectContractText(result: ProductAuditResult, source: string, expectedRoute: string, label: string): void {
  if (!source.includes(expectedRoute)) {
    result.failures.push(`workspace contract is missing ${label} route ${expectedRoute}`);
  }
}

async function auditFilesystemWriters(repoRoot: string, sourceOverrides: Map<string, string> | undefined, result: ProductAuditResult): Promise<void> {
  const writerFiles = ["packages/workspace/src/imports.ts"];
  const violations: string[] = [];
  for (const relativePath of writerFiles) {
    const source = await readSource(repoRoot, relativePath, sourceOverrides);
    for (const match of source.matchAll(routeLiteralPattern)) {
      const literal = match[1] ?? "";
      if (literal.includes("<")) {
        continue;
      }
      violations.push(`${relativePath}: ${literal}`);
    }
  }

  if (violations.length) {
    result.failures.push(`filesystem writers bypass routingPolicy: ${violations.join(", ")}`);
    return;
  }
  result.passes.push("filesystem writers use routingPolicy instead of route literals");
}

async function auditImportStagingExclusion(repoRoot: string, sourceOverrides: Map<string, string> | undefined, result: ProductAuditResult): Promise<void> {
  const source = await readSource(repoRoot, "packages/workspace/src/indexer.ts", sourceOverrides);
  const sourceFile = ts.createSourceFile("packages/workspace/src/indexer.ts", source, ts.ScriptTarget.Latest, true);
  const traversal = functionDeclarations(sourceFile).find((declaration) => declaration.name?.text === "collectMarkdownFiles");
  const skipPredicate = functionDeclarations(sourceFile).find((declaration) => declaration.name?.text === "shouldSkipDirectory");
  const recursiveCalls = traversal === undefined
    ? []
    : nodesInFunction(traversal).filter((node): node is ts.CallExpression => ts.isCallExpression(node)
      && calledName(node) === "collectMarkdownFiles"
      && isIdentifierNamed(node.arguments[0], "fullPath"));
  const predicateSkipsApp = skipPredicate !== undefined && returnsTrueForAppDirectory(skipPredicate);
  const recursiveCallsAreGuarded = traversal !== undefined && recursiveCalls.length > 0 && recursiveCalls.every((recursiveCall) => isRecursiveIndexCallGuarded(traversal, recursiveCall));
  if (!predicateSkipsApp || !recursiveCallsAreGuarded) {
    result.failures.push("indexer does not exclude runtime staging from indexing");
    return;
  }
  result.passes.push("runtime staging is excluded from indexing");
}

function isRecursiveIndexCallGuarded(traversal: ts.FunctionDeclaration, recursiveCall: ts.CallExpression): boolean {
  const recursiveStatement = enclosingStatementInBlock(recursiveCall);
  const directoryBlock = recursiveStatement?.parent;
  const directoryBranch = directoryBlock !== undefined && ts.isBlock(directoryBlock) && ts.isIfStatement(directoryBlock.parent)
    && directoryBlock.parent.thenStatement === directoryBlock
    && isDirectoryBranch(directoryBlock.parent);
  const loop = nearestIterationAncestor(recursiveCall);
  if (!directoryBranch || recursiveStatement === undefined || loop === undefined || !ts.isBlock(directoryBlock)) {
    return false;
  }

  const statementIndex = directoryBlock.statements.indexOf(recursiveStatement);
  return directoryBlock.statements.slice(0, statementIndex).some((statement) => ts.isIfStatement(statement)
    && isSkipDirectoryGuard(statement)
    && hasDirectContinueForLoop(statement.thenStatement, loop));
}

function isDirectoryBranch(node: ts.IfStatement): boolean {
  return ts.isCallExpression(node.expression)
    && ts.isPropertyAccessExpression(node.expression.expression)
    && ts.isIdentifier(node.expression.expression.expression)
    && node.expression.expression.expression.text === "entry"
    && node.expression.expression.name.text === "isDirectory";
}

function isSkipDirectoryGuard(node: ts.IfStatement): boolean {
  return ts.isCallExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "shouldSkipDirectory"
    && isPropertyAccessNamed(node.expression.arguments[0], "entry", "name");
}

function returnsTrueForAppDirectory(predicate: ts.FunctionDeclaration): boolean {
  const body = predicate.body;
  return body !== undefined && body.statements.some((statement) => (ts.isReturnStatement(statement) && returnExpressionIsTrueForApp(statement.expression))
    || (ts.isIfStatement(statement) && isExactAppDirectoryCheck(statement.expression) && returnsTrueDirectly(statement.thenStatement)));
}

function returnExpressionIsTrueForApp(expression: ts.Expression | undefined): boolean {
  return expression !== undefined && (isExactAppDirectoryCheck(expression)
    || (ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      && (returnExpressionIsTrueForApp(expression.left) || returnExpressionIsTrueForApp(expression.right))));
}

function returnsTrueDirectly(statement: ts.Statement): boolean {
  const statements = ts.isBlock(statement) ? statement.statements : [statement];
  return statements.some((child) => ts.isReturnStatement(child) && child.expression?.kind === ts.SyntaxKind.TrueKeyword);
}

function isExactAppDirectoryCheck(node: ts.Node): boolean {
  return ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && isIdentifierNamed(node.left, "name")
    && ts.isStringLiteral(node.right)
    && node.right.text === ".app";
}

function enclosingStatementInBlock(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isStatement(current) && ts.isBlock(current.parent)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function nearestIterationAncestor(node: ts.Node): ts.IterationStatement | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (isIterationStatement(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function isIterationStatement(node: ts.Node): node is ts.IterationStatement {
  return ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node);
}

function hasDirectContinueForLoop(statement: ts.Statement, loop: ts.IterationStatement): boolean {
  const directStatements = ts.isBlock(statement) ? statement.statements : [statement];
  return directStatements.some((child) => ts.isContinueStatement(child) && nearestIterationAncestor(child) === loop);
}

async function auditReviewBypassFields(repoRoot: string, sourceOverrides: Map<string, string> | undefined, result: ProductAuditResult): Promise<void> {
  const sources = await Promise.all([
    readSource(repoRoot, "packages/workspace/src/imports.ts", sourceOverrides),
    readSource(repoRoot, "apps/desktop/electron/ipc.ts", sourceOverrides),
  ]);
  const bypassField = sources
    .map((source, index) => findReviewBypassField(ts.createSourceFile(index === 0 ? "imports.ts" : "ipc.ts", source, ts.ScriptTarget.Latest, true)))
    .find((field) => field !== undefined);
  if (bypassField !== undefined) {
    result.failures.push(`import routing source declares a Review bypass field: ${bypassField}`);
    return;
  }
  result.passes.push("import routing source has no Review bypass field");
}

function findReviewBypassField(sourceFile: ts.SourceFile): string | undefined {
  const bypassNode = nodesInSourceFile(sourceFile).find((node) => isReviewBypassToken(node));
  return bypassNode !== undefined && (ts.isIdentifier(bypassNode) || ts.isStringLiteral(bypassNode) || ts.isNoSubstitutionTemplateLiteral(bypassNode))
    ? bypassNode.text
    : undefined;
}

function nodesInSourceFile(sourceFile: ts.SourceFile): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return nodes;
}

function isReviewBypassToken(node: ts.Node): boolean {
  return (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    && (node.text === "skipReview" || node.text === "bypassReview");
}

async function auditDecisionMirror(repoRoot: string, result: ProductAuditResult): Promise<void> {
  try {
    await access(path.join(repoRoot, "docs/decisions"));
    result.passes.push("implementation repo has a docs/decisions decision mirror");
  } catch {
    result.failures.push("implementation repo is missing docs/decisions ADR mirror");
  }
}

async function readSource(repoRoot: string, relativePath: string, sourceOverrides?: Map<string, string>): Promise<string> {
  const absolutePath = path.join(repoRoot, relativePath);
  return sourceOverrides?.get(absolutePath) ?? readFile(absolutePath, "utf8");
}

async function readGeneratedWorkspaceContract(workspaceRoot: string, result: ProductAuditResult): Promise<string | undefined> {
  try {
    return await readFile(path.join(path.resolve(workspaceRoot), "AGENTS.md"), "utf8");
  } catch {
    result.failures.push("generated workspace AGENTS.md cannot be read");
    return undefined;
  }
}
