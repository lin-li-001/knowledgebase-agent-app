import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultRoutingPolicy } from "./routingPolicy";

export interface ProductAuditInput {
  repoRoot: string;
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
  if (!result.failures.some((failure) => failure.startsWith("workspace contract is missing"))) {
    result.passes.push("routing policy paths are documented in the workspace contract");
  }

  await auditImportRoutingPolicy(repoRoot, input.sourceOverrides, result);
  await auditImportSafetyKernel(repoRoot, input.sourceOverrides, result);
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
  const finalImportWriters = [
    "packages/workspace/src/imports.ts",
    "apps/desktop/electron/ipc.ts",
  ];
  const missingSafetyKernel: string[] = [];
  for (const relativePath of finalImportWriters) {
    const source = await readSource(repoRoot, relativePath, sourceOverrides);
    if (!source.includes("const safetyDecision = evaluateImportSafety({")) {
      missingSafetyKernel.push(relativePath);
    }
  }

  if (missingSafetyKernel.length) {
    result.failures.push(`final import writes do not invoke the Safety Kernel: ${missingSafetyKernel.join(", ")}`);
    return;
  }
  result.passes.push("final import writes invoke the Safety Kernel");
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
