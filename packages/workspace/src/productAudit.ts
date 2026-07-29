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
    && resolvesToBinding(declaration, expression.left.expression) === binding
    && expression.left.name.text === "decision"
    && ts.isStringLiteral(expression.right)
    && expression.right.text === "auto_write";
}

function resolvesToBinding(declaration: ts.FunctionDeclaration, reference: ts.Identifier): ts.VariableDeclaration | undefined {
  const candidates = nodesInFunction(declaration).filter((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === reference.text
    && node.pos < reference.pos
    && nodeIsInside(reference, declarationScope(node, declaration)));
  return candidates.sort((left, right) => scopeDepth(declarationScope(right, declaration)) - scopeDepth(declarationScope(left, declaration)))[0];
}

function declarationScope(variable: ts.VariableDeclaration, declaration: ts.FunctionDeclaration): ts.Node {
  let current: ts.Node | undefined = variable.parent;
  while (current !== undefined && current !== declaration) {
    if (ts.isBlock(current)) {
      return current;
    }
    current = current.parent;
  }
  return declaration;
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
    && isMethodCall(node, "fileOps", "writeFile")
    && node.arguments[0] !== undefined
    && ts.isIdentifier(node.arguments[0])
    && node.arguments[0].text === "finalTargetPath"
    && isAwaitedMethodCall(node.arguments[1], "fileOps", "readFile", "stagingTargetPath")
    && node.arguments[2]?.kind === ts.SyntaxKind.TrueKeyword;
}

function isReviewImportPromotionWrite(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "secureWriteExclusive"
    && node.arguments.length === 5
    && isIdentifierNamed(node.arguments[0], "workspaceRoot")
    && isIdentifierNamed(node.arguments[1], "approvedDestinationPath")
    && isIdentifierNamed(node.arguments[2], "approvedBody")
    && isIdentifierNamed(node.arguments[3], "fileOps")
    && isPropertyAccessNamed(node.arguments[4], "application", "ioHooks");
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
