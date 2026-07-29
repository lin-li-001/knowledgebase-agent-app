import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditProductContracts as auditProductContractsImplementation,
  createWorkspace,
  type ProductAuditInput,
} from "../src/index";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kb-product-audit-workspace-"));
  await createWorkspace(workspaceRoot);
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function auditProductContracts(input: Omit<ProductAuditInput, "workspaceRoot">) {
  return auditProductContractsImplementation({ ...input, workspaceRoot });
}

describe("product audit", () => {
  it("checks product contract drift in the current repo", async () => {
    const result = await auditProductContracts({ repoRoot });

    expect(result.failures).toEqual([]);
    expect(result.passes).toContain("routing policy paths are documented in the workspace contract");
    expect(result.passes).toContain("import routing precedence is documented in the workspace contract");
    expect(result.passes).toContain("import candidate routing precedence is implemented");
    expect(result.passes).toContain("final import writes invoke the Safety Kernel");
    expect(result.passes).toContain("import staging is documented as non-indexed");
    expect(result.passes).toContain("filesystem writers use routingPolicy instead of route literals");
    expect(result.passes).toContain("implementation repo has a docs/decisions decision mirror");
    expect(result.warnings).toEqual([]);
  });

  it("fails when the generated workspace AGENTS contract is changed after creation", async () => {
    const agentsPath = path.join(workspaceRoot, "AGENTS.md");
    const agents = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, agents.replace("Saved workspace routing rules never bypass Review.", "Saved rules auto-approve imports."));

    const result = await auditProductContracts({ repoRoot });

    expect(result.failures).toContain("generated workspace AGENTS.md is missing import routing precedence terms: Saved workspace routing rules never bypass Review.");
  });

  it("fails when the generated workspace AGENTS contract omits the Safety Kernel requirement", async () => {
    const agentsPath = path.join(workspaceRoot, "AGENTS.md");
    const agents = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, agents.replace("The Safety Kernel must approve every final import write.", "Final import writes are reviewed."));

    const result = await auditProductContracts({ repoRoot });

    expect(result.failures).toContain("generated workspace AGENTS.md is missing the Safety Kernel contract");
  });

  it("fails when the workspace contract disagrees with routing policy paths", async () => {
    const contractPath = path.join(repoRoot, "packages/workspace/src/templates.ts");
    const contractSource = await readFile(contractPath, "utf8");
    const brokenContractSource = contractSource.replace(
      "04-Resources/Imports/<batch-name>/<source-stem>.md",
      "03-Knowledge/Imports/<batch-name>/<source-stem>.md",
    );

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, brokenContractSource]]),
    });

    expect(result.failures).toContain("workspace contract is missing per-source import note route 04-Resources/Imports/<batch-name>/<source-stem>.md");
  });

  it("fails when the workspace contract omits the per-source import note route", async () => {
    const contractPath = path.join(repoRoot, "packages/workspace/src/templates.ts");
    const contractSource = await readFile(contractPath, "utf8");
    const legacyContractSource = contractSource.replace(
      "Imported source Markdown notes go to \\`04-Resources/Imports/<batch-name>/<source-stem>.md\\` while pending Review; low-risk imports are immediately written to \\`00-Inbox/Imports/\\`.",
      "Imported summary notes go to \\`04-Resources/Imports/<batch-name>.md\\`.",
    );

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, legacyContractSource]]),
    });

    expect(result.failures).toContain(
      "workspace contract is missing per-source import note route 04-Resources/Imports/<batch-name>/<source-stem>.md",
    );
  });

  it("fails when the workspace contract omits imported source note route status", async () => {
    const contractPath = path.join(repoRoot, "packages/workspace/src/templates.ts");
    const contractSource = await readFile(contractPath, "utf8");
    const legacyContractSource = contractSource.replace(
      "Each imported source note records \\`route_status\\` and \\`route_destination\\`; a Review approval moves that same note to its final destination.",
      "Imported notes are routed after import.",
    );

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, legacyContractSource]]),
    });

    expect(result.failures).toContain("workspace contract is missing imported source note route status fields");
  });

  it("fails when the workspace contract omits the decision route", async () => {
    const contractPath = path.join(repoRoot, "packages/workspace/src/templates.ts");
    const contractSource = await readFile(contractPath, "utf8");
    const brokenContractSource = contractSource.replace("\\`.vault/decisions/<decision-id>.md\\`", "\\`01-Projects/Decisions/<decision-id>.md\\`");

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, brokenContractSource]]),
    });

    expect(result.failures).toContain("workspace contract is missing decision route .vault/decisions/<decision-id>.md");
  });

  it("fails when the workspace contract omits import routing precedence", async () => {
    const contractPath = path.join(repoRoot, "packages/workspace/src/templates.ts");
    const contractSource = await readFile(contractPath, "utf8");
    const brokenContractSource = contractSource.replace("Current Review category and destination overrides", "Manual path");

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, brokenContractSource]]),
    });

    expect(result.failures).toContain("workspace contract is missing import routing precedence terms: Current Review category and destination overrides");
  });

  it("fails when the workspace contract omits current user precedence", async () => {
    const contractPath = path.join(repoRoot, "packages/workspace/src/templates.ts");
    const contractSource = await readFile(contractPath, "utf8");
    const brokenContractSource = contractSource.replace("Current Review category and destination overrides", "Semantic category and destination routing");

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, brokenContractSource]]),
    });

    expect(result.failures).toContain("workspace contract is missing import routing precedence terms: Current Review category and destination overrides");
  });

  it("fails when the workspace contract documents staging as indexed", async () => {
    const contractPath = path.join(repoRoot, "packages/workspace/src/templates.ts");
    const contractSource = await readFile(contractPath, "utf8");
    const brokenContractSource = contractSource.replace(
      "Pending import notes are non-indexed",
      "Pending import notes are indexed",
    );

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, brokenContractSource]]),
    });

    expect(result.failures).toContain("workspace contract documents pending imports as indexed");
  });

  it("fails when final import writes do not invoke the Safety Kernel", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = importsSource.replace(
      "const safetyDecision = evaluateImportSafety({",
      "const safetyDecision = missingSafetyKernel({",
    );

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer does not call the Safety Kernel: packages/workspace/src/imports.ts");
  });

  it("does not accept a commented or unused Safety Kernel call as an implementation gate", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = importsSource.replace(
      "const safetyDecision = evaluateImportSafety({",
      "const decoy = \"const safetyDecision = evaluateImportSafety({\";\n  // const safetyDecision = evaluateImportSafety({\n  const safetyDecision = missingSafetyKernel({",
    );

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer does not call the Safety Kernel: packages/workspace/src/imports.ts");
  });

  it("fails when an importer final write is not structurally gated on auto_write", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = importsSource.replace("if (status === \"auto_written\")", "if (status === \"unsafe\")");

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: packages/workspace/src/imports.ts");
  });

  it("fails when source code declares an import Review bypass field", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}\nconst unsafeRule = { skipReview: true };\n`;

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("import routing source declares a Review bypass field: skipReview");
  });

  it("fails when the indexer no longer excludes the runtime staging directory", async () => {
    const indexerPath = path.join(repoRoot, "packages/workspace/src/indexer.ts");
    const indexerSource = await readFile(indexerPath, "utf8");
    const brokenIndexerSource = indexerSource.replace('name === ".app"', 'name === ".runtime"');

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[indexerPath, brokenIndexerSource]]),
    });

    expect(result.failures).toContain("indexer does not exclude runtime staging from indexing");
  });

  it("treats import staging literals as routing-policy bypasses", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = importsSource.replace(
      "defaultRoutingPolicy.importStagingNotePath(importId, title)",
      "\".app/import-staging/unsafe.md\"",
    );

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain(
      "filesystem writers bypass routingPolicy: packages/workspace/src/imports.ts: .app/import-staging/unsafe.md",
    );
  });

  it("fails when the import candidate routing implementation omits the inbox fallback precedence", async () => {
    const policyPath = path.join(repoRoot, "packages/workspace/src/importCandidateRoutingPolicy.ts");
    const policySource = await readFile(policyPath, "utf8");
    const brokenPolicySource = policySource.replace("inbox_import_fallback", "missing_inbox_fallback");

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[policyPath, brokenPolicySource]]),
    });

    expect(result.failures).toContain("import candidate routing policy is missing precedence tokens: inbox_import_fallback");
  });

  it("fails when the implementation repo has no decision mirror", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kb-product-audit-"));
    try {
      await mkdir(path.join(tempRoot, "packages/workspace/src"), { recursive: true });
      const contractSource = await readFile(path.join(repoRoot, "packages/workspace/src/templates.ts"), "utf8");
      const importsSource = await readFile(path.join(repoRoot, "packages/workspace/src/imports.ts"), "utf8");
      const importRoutingSource = await readFile(path.join(repoRoot, "packages/workspace/src/importCandidateRoutingPolicy.ts"), "utf8");
      const workspaceSource = await readFile(path.join(repoRoot, "packages/workspace/src/workspace.ts"), "utf8");
      const indexerSource = await readFile(path.join(repoRoot, "packages/workspace/src/indexer.ts"), "utf8");
      const ipcSource = await readFile(path.join(repoRoot, "apps/desktop/electron/ipc.ts"), "utf8");
      await writeFile(path.join(tempRoot, "packages/workspace/src/templates.ts"), contractSource);
      await writeFile(path.join(tempRoot, "packages/workspace/src/imports.ts"), importsSource);
      await writeFile(path.join(tempRoot, "packages/workspace/src/importCandidateRoutingPolicy.ts"), importRoutingSource);
      await writeFile(path.join(tempRoot, "packages/workspace/src/workspace.ts"), workspaceSource);
      await writeFile(path.join(tempRoot, "packages/workspace/src/indexer.ts"), indexerSource);
      await mkdir(path.join(tempRoot, "apps/desktop/electron"), { recursive: true });
      await writeFile(path.join(tempRoot, "apps/desktop/electron/ipc.ts"), ipcSource);

      const result = await auditProductContracts({ repoRoot: tempRoot });

      expect(result.failures).toContain("implementation repo is missing docs/decisions ADR mirror");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
