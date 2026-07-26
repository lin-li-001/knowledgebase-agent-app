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

const routeLiteralPattern = /["'`]((?:04-Resources\/Imports|06-Attachments\/Imports|02-Profiles\/[^"'`]+\/(?:Profile|Memory)\.md|\.vault\/decisions|\.app\/exports)[^"'`]*)["'`]/gu;

export async function auditProductContracts(input: ProductAuditInput): Promise<ProductAuditResult> {
  const repoRoot = path.resolve(input.repoRoot);
  const result: ProductAuditResult = { passes: [], warnings: [], failures: [] };
  const workspaceContractSource = await readSource(repoRoot, "packages/workspace/src/templates.ts", input.sourceOverrides);
  const importSummaryRoute = `${defaultRoutingPolicy.importSummaryDir()}/<batch-name>.md`;
  const importAttachmentRoute = `${defaultRoutingPolicy.importAttachmentRoot()}/<batch-name>/`;
  const profileMemoryRoute = "02-Profiles/<profile-id>/Memory.md";
  const decisionRoute = ".vault/decisions/<decision-id>.md";

  expectContractText(result, workspaceContractSource, importSummaryRoute, "import summary");
  expectContractText(result, workspaceContractSource, importAttachmentRoute, "import attachment");
  expectContractText(result, workspaceContractSource, profileMemoryRoute, "profile memory");
  expectContractText(result, workspaceContractSource, decisionRoute, "decision");
  if (!result.failures.some((failure) => failure.startsWith("workspace contract is missing"))) {
    result.passes.push("routing policy paths are documented in the workspace contract");
  }

  await auditFilesystemWriters(repoRoot, input.sourceOverrides, result);
  await auditDecisionMirror(repoRoot, result);
  return result;
}

function expectContractText(result: ProductAuditResult, source: string, expectedRoute: string, label: string): void {
  if (!source.includes(expectedRoute)) {
    result.failures.push(`workspace contract is missing ${label} route ${expectedRoute}`);
  }
}

async function auditFilesystemWriters(repoRoot: string, sourceOverrides: Map<string, string> | undefined, result: ProductAuditResult): Promise<void> {
  const writerFiles = [
    "packages/workspace/src/imports.ts",
    "packages/workspace/src/workspace.ts",
  ];
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
