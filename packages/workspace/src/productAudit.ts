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
  const importSourceNoteRoute = `${defaultRoutingPolicy.importSummaryDir()}/<batch-name>/<source-stem>.md`;
  const importAttachmentRoute = `${defaultRoutingPolicy.importAttachmentRoot()}/<batch-name>/`;
  const inboxFallbackRoute = `${defaultRoutingPolicy.importInboxDir()}/<batch-name>.md`;
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
  if (source.includes("Pending import notes are indexed")) {
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

// These checks bind named safety data flow to the local function that performs each final write.
// They cannot prove behavior through dynamic dispatch, runtime code generation, or aliased module imports.
function auditImporterSafetyKernel(relativePath: string, source: string, result: ProductAuditResult): void {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  if (!importsNamedBinding(sourceFile, "./importSafety", "evaluateImportSafety")) {
    result.failures.push(`final import writer does not import the Safety Kernel: ${relativePath}`);
    return;
  }

  const promotionFunctions = functionDeclarations(sourceFile).filter((declaration) => functionContains(declaration, isFinalImportPromotionWrite));
  if (!promotionFunctions.length || !promotionFunctions.every((declaration) => functionContains(declaration, (node) => isVariableCall(node, "safetyDecision", "evaluateImportSafety")))) {
    result.failures.push(`final import writer does not call the Safety Kernel: ${relativePath}`);
    return;
  }
  if (!promotionFunctions.every(hasImporterAutoWriteGate)) {
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

  const reviewFunctions = functionDeclarations(sourceFile).filter((declaration) => functionContains(declaration, isReviewImportPromotionWrite));
  if (!reviewFunctions.length || !reviewFunctions.every((declaration) => functionContains(declaration, (node) => isVariableCall(node, "safetyDecision", "evaluateImportSafety")))) {
    result.failures.push(`final import writer does not call the Safety Kernel: ${relativePath}`);
    return;
  }
  if (!reviewFunctions.every(hasReviewAutoWriteGate)) {
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

function hasImporterAutoWriteGate(declaration: ts.FunctionDeclaration): boolean {
  const finalWrite = findNodeInFunction(declaration, isFinalImportPromotionWrite);
  if (!finalWrite || !ts.isCallExpression(finalWrite)) {
    return false;
  }

  const safetyDecision = findNodeInFunction(declaration, (node) => isVariableCall(node, "safetyDecision", "evaluateImportSafety"));
  const status = findNodeInFunction(declaration, (node) => isVariableCall(node, "status", "artifactStatusFor", "safetyDecision"));
  const guard = findNodeInFunction(declaration, (node) => ts.isIfStatement(node)
    && isEqualityWithString(node.expression, "status", "auto_written")
    && containsOutsideNestedFunctions(node.thenStatement, isFinalImportPromotionWrite));
  return safetyDecision !== undefined
    && status !== undefined
    && guard !== undefined
    && safetyDecision.end < status.pos
    && status.end < guard.pos
    && guard.pos < finalWrite.pos;
}

function hasReviewAutoWriteGate(declaration: ts.FunctionDeclaration): boolean {
  const finalWrite = findNodeInFunction(declaration, isReviewImportPromotionWrite);
  const safetyDecision = findNodeInFunction(declaration, (node) => isVariableCall(node, "safetyDecision", "evaluateImportSafety"));
  const gate = findNodeInFunction(declaration, (node) => ts.isIfStatement(node)
    && isReviewAutoWriteGuard(node.expression)
    && sourceContains(node.thenStatement, ts.isThrowStatement));
  return finalWrite !== undefined
    && safetyDecision !== undefined
    && gate !== undefined
    && safetyDecision.end < gate.pos
    && gate.end < finalWrite.pos;
}

function isFinalImportPromotionWrite(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && calledName(node) === "writeFile"
    && node.arguments[0] !== undefined
    && ts.isIdentifier(node.arguments[0])
    && node.arguments[0].text === "finalTargetPath"
    && node.arguments[2]?.kind === ts.SyntaxKind.TrueKeyword;
}

function isReviewImportPromotionWrite(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && calledName(node) === "secureWriteExclusive"
    && node.arguments[1] !== undefined
    && ts.isIdentifier(node.arguments[1])
    && node.arguments[1].text === "approvedDestinationPath";
}

function isVariableCall(node: ts.Node, variableName: string, callName: string, argumentName?: string): boolean {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== variableName || !node.initializer || !ts.isCallExpression(node.initializer)) {
    return false;
  }
  return calledName(node.initializer) === callName
    && (argumentName === undefined || node.initializer.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === argumentName));
}

function isEqualityWithString(expression: ts.Expression, identifier: string, value: string): boolean {
  if (!ts.isBinaryExpression(expression) || (expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken && expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken)) {
    return false;
  }
  return (ts.isIdentifier(expression.left) && expression.left.text === identifier && ts.isStringLiteral(expression.right) && expression.right.text === value)
    || (ts.isIdentifier(expression.right) && expression.right.text === identifier && ts.isStringLiteral(expression.left) && expression.left.text === value);
}

function isReviewAutoWriteGuard(expression: ts.Expression): boolean {
  return sourceContains(expression, (node) => ts.isStringLiteral(node) && node.text === "auto_write")
    && sourceContains(expression, (node) => ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "safetyDecision"
      && node.name.text === "decision");
}

function calledName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  return ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
}

function sourceContains(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  return findNode(root, predicate) !== undefined;
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

function functionContains(functionDeclaration: ts.FunctionDeclaration, predicate: (node: ts.Node) => boolean): boolean {
  return findNodeInFunction(functionDeclaration, predicate) !== undefined;
}

function findNodeInFunction(functionDeclaration: ts.FunctionDeclaration, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  const visit = (node: ts.Node): ts.Node | undefined => {
    if (predicate(node)) {
      return node;
    }
    if (node !== functionDeclaration && ts.isFunctionLike(node)) {
      return undefined;
    }
    return ts.forEachChild(node, visit);
  };
  return visit(functionDeclaration);
}

function containsOutsideNestedFunctions(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  const visit = (node: ts.Node): ts.Node | undefined => {
    if (predicate(node)) {
      return node;
    }
    if (node !== root && ts.isFunctionLike(node)) {
      return undefined;
    }
    return ts.forEachChild(node, visit);
  };
  return visit(root) !== undefined;
}

function findNode(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  if (predicate(root)) {
    return root;
  }
  return ts.forEachChild(root, (child) => findNode(child, predicate));
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
  const traversalUsesPredicate = traversal !== undefined && functionContains(traversal, (node) => ts.isCallExpression(node) && calledName(node) === "shouldSkipDirectory");
  const predicateSkipsApp = skipPredicate !== undefined && functionContains(skipPredicate, (node) => ts.isExpression(node) && isEqualityWithString(node, "name", ".app"));
  if (!traversalUsesPredicate || !predicateSkipsApp) {
    result.failures.push("indexer does not exclude runtime staging from indexing");
    return;
  }
  result.passes.push("runtime staging is excluded from indexing");
}

async function auditReviewBypassFields(repoRoot: string, sourceOverrides: Map<string, string> | undefined, result: ProductAuditResult): Promise<void> {
  const source = await readSource(repoRoot, "packages/workspace/src/imports.ts", sourceOverrides);
  const sourceFile = ts.createSourceFile("packages/workspace/src/imports.ts", source, ts.ScriptTarget.Latest, true);
  const bypassField = findNode(sourceFile, (node) => isReviewBypassIdentifier(node) || isReviewBypassStringKey(node));
  if (bypassField) {
    result.failures.push(`import routing source declares a Review bypass field: ${reviewBypassName(bypassField)}`);
    return;
  }
  result.passes.push("import routing source has no Review bypass field");
}

function isReviewBypassIdentifier(node: ts.Node): boolean {
  return ts.isIdentifier(node) && (node.text === "skipReview" || node.text === "bypassReview");
}

function isReviewBypassStringKey(node: ts.Node): boolean {
  return ts.isStringLiteral(node)
    && (node.text === "skipReview" || node.text === "bypassReview")
    && ((ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
      || (ts.isComputedPropertyName(node.parent) && node.parent.expression === node));
}

function reviewBypassName(node: ts.Node): string {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : "unknown";
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
