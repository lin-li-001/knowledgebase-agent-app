import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../src/index";
import {
  auditProductContracts as auditProductContractsImplementation,
  type ProductAuditInput,
} from "../src/productAudit";

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

function expectSourceOverrideToCompile(sourcePath: string, source: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext },
    fileName: sourcePath,
    reportDiagnostics: true,
  });

  expect(result.diagnostics ?? []).toEqual([]);
}

function expectSourceOverrideToTypecheck(sourcePath: string, source: string): void {
  const configPath = sourcePath.includes(`${path.sep}apps${path.sep}desktop${path.sep}`)
    ? path.join(repoRoot, "apps/desktop/tsconfig.json")
    : path.join(repoRoot, "packages/workspace/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath);
  const compilerHost = ts.createCompilerHost(parsed.options);
  const readFileFromDisk = compilerHost.readFile.bind(compilerHost);
  const normalizedSourcePath = path.resolve(sourcePath);
  compilerHost.readFile = (fileName) => path.resolve(fileName) === normalizedSourcePath ? source : readFileFromDisk(fileName);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    host: compilerHost,
  });

  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(diagnostics).toEqual([]);
}

function importerWriterFixture(
  importsSource: string,
  guardBody: string,
  kernelBinding = "safetyDecision",
  extraParameter = "",
  kernelDeclaration = "const",
  beforeKernel = "",
): string {
  return `${importsSource}
async function adversarialPromotion(
  fileOps: ImportFileOps,
  fabricated: SafetyDecision${extraParameter},
) {
  const workspaceRoot = "/workspace";
  const routed: RoutedDocument = {
    classification: {
      primaryCategory: "resource",
      alternativeCategories: [],
      sensitivity: "normal",
      confidence: 1,
      evidence: [],
      signals: [],
      conflict: false,
    },
    destination: "00-Inbox/Imports/adversarial.md",
  };
  const stagingTargetPath = assertInsideWorkspace(workspaceRoot, [".app", "import-staging", "adversarial.md"].join("/"));
  const finalTargetPath = assertInsideWorkspace(workspaceRoot, routed.destination);
${beforeKernel}  ${kernelDeclaration} ${kernelBinding} = evaluateImportSafety({
    workspaceRoot,
    operation: "create",
    destination: routed.destination,
    destinationExists: false,
    autoWriteThreshold: 0.95,
    classification: routed.classification,
  });
${guardBody}
}
`;
}

describe("product audit", () => {
  it("checks product contract drift in the current repo", async () => {
    const result = await auditProductContracts({ repoRoot });

    expect(result.failures).toEqual([]);
    expect(result.passes).toContain("routing policy paths are documented in the workspace contract");
    expect(result.passes).toContain("import routing precedence is documented in the workspace contract");
    expect(result.passes).toContain("import candidate routing precedence is implemented");
    expect(result.passes).toContain("final import writes invoke the Safety Kernel");
    expect(result.passes).toContain(
      "initial import attachment, staging, journal, and final writes use hardened workspace IO",
    );
    expect(result.passes).toContain(
      "secure import extraction consumes identity-verified copied attachment bytes",
    );
    expect(result.passes).toContain(
      "import rollback and retirement cleanup are identity-bound quarantine operations",
    );
    expect(result.passes).toContain(
      "routing policy and AGENTS updates use the canonical cross-process workspace lock",
    );
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
      ".app/import-staging/<import-id>/<source-stem>.md",
      "03-Knowledge/Imports/<import-id>/<source-stem>.md",
    );

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, brokenContractSource]]),
    });

    expect(result.failures).toContain("workspace contract is missing per-source import note route .app/import-staging/<import-id>/<source-stem>.md");
  });

  it("rejects the obsolete 04-Resources pending-note route", async () => {
    const contractPath = path.join(repoRoot, "packages/workspace/src/templates.ts");
    const contractSource = await readFile(contractPath, "utf8");
    const legacyContractSource = contractSource.replace(
      "Imported source Markdown notes remain non-indexed under \\`.app/import-staging/<import-id>/<source-stem>.md\\` while pending Review; low-risk imports are immediately written to \\`00-Inbox/Imports/\\`.",
      "Imported source Markdown notes go to \\`04-Resources/Imports/<import-id>/<source-stem>.md\\` while pending Review; low-risk imports are immediately written to \\`00-Inbox/Imports/\\`.",
    );

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, legacyContractSource]]),
    });

    expect(result.failures).toContain(
      "workspace contract is missing per-source import note route .app/import-staging/<import-id>/<source-stem>.md",
    );
    expect(result.failures).toContain(
      "workspace contract retains obsolete 04-Resources/Imports pending-note route",
    );
  });

  it("rejects an obsolete pending-note route in generated AGENTS.md", async () => {
    const agentsPath = path.join(workspaceRoot, "AGENTS.md");
    const agents = await readFile(agentsPath, "utf8");
    await writeFile(
      agentsPath,
      agents.replace(
        "Imported source Markdown notes remain non-indexed under `.app/import-staging/<import-id>/<source-stem>.md` while pending Review",
        "Imported source Markdown notes go to `04-Resources/Imports/<import-id>/<source-stem>.md` while pending Review",
      ),
      "utf8",
    );

    const result = await auditProductContracts({ repoRoot });

    expect(result.failures).toContain(
      "generated workspace AGENTS.md retains obsolete 04-Resources/Imports pending-note route",
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
    const brokenImportsSource = `${importsSource.replace(
      "const safetyDecision = evaluateImportSafety({",
      "const safetyDecision = missingSafetyKernel({",
    )}
function missingSafetyKernel(intent: Parameters<typeof evaluateImportSafety>[0]): SafetyDecision {
  return { decision: "blocked", reasonCodes: [] };
}
`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer does not call the Safety Kernel: packages/workspace/src/imports.ts");
  });

  it("does not accept a commented or unused Safety Kernel call as an implementation gate", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource.replace(
      "const safetyDecision = evaluateImportSafety({",
      "const decoy = \"const safetyDecision = evaluateImportSafety({\";\n  // const safetyDecision = evaluateImportSafety({\n  const safetyDecision = missingSafetyKernel({",
    )}
function missingSafetyKernel(intent: Parameters<typeof evaluateImportSafety>[0]): SafetyDecision {
  return { decision: "blocked", reasonCodes: [] };
}
`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer does not call the Safety Kernel: packages/workspace/src/imports.ts");
  });

  it("fails when attachment copy bypasses hardened workspace IO", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource.replace(
      "await secureCopyFileIntoWorkspace(\n        input.workspaceRoot,",
      "await unsafeAttachmentCopy(\n        input.workspaceRoot,",
    )}
const unsafeAttachmentCopy = secureCopyFileIntoWorkspace;
`;
    expectSourceOverrideToTypecheck(importsPath, brokenImportsSource);

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain(
      "initial import attachment write bypasses hardened workspace IO: packages/workspace/src/imports.ts",
    );
  });

  it("rejects verified-buffer decoys when extraction reopens the attachment path", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource.replace(
      "        copied.contents,\n",
      "        await readFile(attachmentTargetPath),\n",
    )}
function verifiedBufferDecoy(copied: { contents: Buffer }): void {
  void copied.contents;
}
`;

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain(
      "secure import extraction does not consume identity-verified copied attachment bytes",
    );
  });

  it("rejects extractor buffer decoys when an extractor reopens sourcePath", async () => {
    const extractorPath = path.join(
      repoRoot,
      "packages/workspace/src/importExtractors.ts",
    );
    const extractorSource = await readFile(extractorPath, "utf8");
    const brokenExtractorSource = `import { readFile } from "node:fs/promises";
${extractorSource.replace(
  "    const text = verifiedContents.toString(\"utf8\");",
  "    void verifiedContents;\n    const text = await readFile(sourcePath, \"utf8\");",
)}`;

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[extractorPath, brokenExtractorSource]]),
    });

    expect(result.failures).toContain(
      "secure import extraction does not consume identity-verified copied attachment bytes",
    );
  });

  it("fails when staging creation bypasses hardened workspace IO", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource.replace(
      "await secureWriteWorkspaceFileExclusive(\n    workspaceRoot,\n    stagingTargetPath,",
      "await unsafeStagingWrite(\n    workspaceRoot,\n    stagingTargetPath,",
    )}
const unsafeStagingWrite = secureWriteWorkspaceFileExclusive;
`;
    expectSourceOverrideToTypecheck(importsPath, brokenImportsSource);

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain(
      "initial import staging write bypasses hardened workspace IO: packages/workspace/src/imports.ts",
    );
  });

  it("fails when final promotion aliases around hardened workspace IO", async () => {
    const promotionPath = path.join(
      repoRoot,
      "packages/workspace/src/importPromotion.ts",
    );
    const promotionSource = await readFile(promotionPath, "utf8");
    const brokenPromotionSource = `${promotionSource.replace(
      "  return securePublishWorkspaceFileAtomic(\n",
      "  return unsafeFinalWrite(\n",
    )}
const unsafeFinalWrite = securePublishWorkspaceFileAtomic;
`;
    expectSourceOverrideToTypecheck(promotionPath, brokenPromotionSource);

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[promotionPath, brokenPromotionSource]]),
    });

    expect(result.failures).toContain(
      "initial import final write bypasses hardened workspace IO: packages/workspace/src/importPromotion.ts",
    );
  });

  it("rejects an atomic journal token decoy when phase updates use an alias", async () => {
    const promotionPath = path.join(
      repoRoot,
      "packages/workspace/src/importPromotion.ts",
    );
    const promotionSource = await readFile(promotionPath, "utf8");
    const brokenPromotionSource = `${promotionSource.replace(
      "  handle.artifact = await secureAtomicReplaceWorkspaceFile(\n",
      "  handle.artifact = await aliasedJournalReplace(\n",
    )}
const aliasedJournalReplace = secureAtomicReplaceWorkspaceFile;
`;

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[promotionPath, brokenPromotionSource]]),
    });

    expect(result.failures).toContain(
      "initial import final write bypasses hardened workspace IO: packages/workspace/src/importPromotion.ts",
    );
  });

  it("rejects identity-cleanup token decoys outside the batch rollback", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource.replace(
      "      await secureRemoveWorkspaceArtifact(\n        workspaceRoot,\n        artifact,",
      "      await unsafeCleanup(\n        workspaceRoot,\n        artifact,",
    )}
const unsafeCleanup = async (
  _workspaceRoot: string,
  artifact: SecureWorkspaceArtifactIdentity,
  _options: unknown,
): Promise<void> => unlink(artifact.targetPath);
void secureRemoveWorkspaceArtifact;
`;

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain(
      "import rollback and retirement cleanup are not identity-bound quarantine operations",
    );
  });

  it("rejects a cross-process lock token decoy outside the routing update", async () => {
    const reviewPath = path.join(repoRoot, "apps/desktop/electron/ipc.ts");
    const reviewSource = await readFile(reviewPath, "utf8");
    const brokenReviewSource = `${reviewSource.replace(
      "  await withWorkspaceWriteLock(workspaceRoot, async (canonicalRoot) => {",
      "  await withoutWorkspaceLock(workspaceRoot, async (canonicalRoot) => {",
    )}
async function withoutWorkspaceLock<T>(
  workspaceRoot: string,
  operation: (canonicalRoot: string) => Promise<T>,
): Promise<T> {
  return operation(await realpath(workspaceRoot));
}
void withWorkspaceWriteLock;
`;

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[reviewPath, brokenReviewSource]]),
    });

    expect(result.failures).toContain(
      "routing policy and AGENTS updates are not protected by the canonical cross-process workspace lock",
    );
  });

  it("fails when the shared boundary drops no-follow protection", async () => {
    const secureIoPath = path.join(
      repoRoot,
      "packages/workspace/src/secureWorkspaceIo.ts",
    );
    const secureIoSource = await readFile(secureIoPath, "utf8");
    const brokenSecureIoSource = secureIoSource.replaceAll(
      "constants.O_NOFOLLOW",
      "constants.O_RDONLY",
    );
    expectSourceOverrideToTypecheck(secureIoPath, brokenSecureIoSource);

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[secureIoPath, brokenSecureIoSource]]),
    });

    expect(result.failures).toContain(
      "hardened workspace IO is missing real-path, ancestor, inode, or exclusive-open checks: packages/workspace/src/secureWorkspaceIo.ts",
    );
  });

  it("fails when an importer final write is not structurally gated on auto_write", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = importsSource.replace("if (safetyDecision.decision === \"auto_write\")", "if (safetyDecision.decision !== \"auto_write\")");

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: packages/workspace/src/imports.ts");
  });

  it("rejects an importer guard bound to a fabricated decision", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource.replace(
      "const safetyDecision = evaluateImportSafety({",
      "const safetyDecision = fabricatedSafetyDecision(routed.destination);\n  const unusedSafetyDecision = evaluateImportSafety({",
    )}
function fabricatedSafetyDecision(destination: string): SafetyDecision {
  return { decision: "auto_write", reasonCodes: [], allowedDestination: destination };
}
`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: packages/workspace/src/imports.ts");
  });

  it.each([
    [
      "object shorthand",
      `  {
    const { safetyDecision } = { safetyDecision: fabricated };
    if (safetyDecision.decision === "auto_write") {
      await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
    }
  }`,
      "safetyDecision",
      "",
    ],
    [
      "aliased object binding",
      `  {
    const { safetyDecision: local } = { safetyDecision: fabricated };
    if (local.decision === "auto_write") {
      await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
    }
  }`,
      "safetyDecision",
      "",
    ],
    [
      "array binding",
      `  {
    const [safetyDecision] = [fabricated];
    if (safetyDecision.decision === "auto_write") {
      await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
    }
  }`,
      "safetyDecision",
      "",
    ],
    [
      "parameter",
      `  if (safetyDecision.decision === "auto_write") {
    await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
  }`,
      "kernelDecision",
      ",\n  safetyDecision: SafetyDecision",
    ],
    [
      "catch binding",
      `  try {
    throw fabricated;
  } catch (safetyDecision) {
    if (safetyDecision.decision === "auto_write") {
      await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
    }
  }`,
      "safetyDecision",
      "",
    ],
  ])("rejects an importer guard using a %s shadow", async (_label, guardBody, kernelBinding, extraParameter) => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = importerWriterFixture(importsSource, guardBody, kernelBinding, extraParameter);

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: packages/workspace/src/imports.ts");
  });

  it("accepts an importer guard using its direct non-shadowed kernel binding", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const validImportsSource = importerWriterFixture(
      importsSource,
      `  if (kernelDecision.decision === "auto_write") {
    await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
  }`,
      "kernelDecision",
    );

    expectSourceOverrideToCompile(importsPath, validImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, validImportsSource]]),
    });

    expect(result.failures).toEqual([]);
  });

  it("accepts a later typed var redeclaration of the kernel binding", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const validImportsSource = importerWriterFixture(
      importsSource,
      `  var safetyDecision: SafetyDecision;
  if (safetyDecision.decision === "auto_write") {
    await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
  }`,
      "safetyDecision",
      "",
      "var",
    );

    expectSourceOverrideToTypecheck(importsPath, validImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, validImportsSource]]),
    });

    expect(result.failures).toEqual([]);
  });

  it.each([
    [
      "a fabricated initializer after the kernel",
      "",
      `  var safetyDecision = fabricated;
  if (safetyDecision.decision === "auto_write") {
    await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
  }`,
    ],
    [
      "a second kernel initializer after the kernel",
      "",
      `  var safetyDecision = evaluateImportSafety({
    workspaceRoot,
    operation: "create",
    destination: routed.destination,
    destinationExists: false,
    autoWriteThreshold: 0.95,
    classification: routed.classification,
  });
  if (safetyDecision.decision === "auto_write") {
    await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
  }`,
    ],
    [
      "a fabricated initializer before the kernel",
      "  var safetyDecision = fabricated;\n",
      `  if (safetyDecision.decision === "auto_write") {
    await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
  }`,
    ],
    [
      "a fabricated initializer after the guarded writer",
      "",
      `  if (safetyDecision.decision === "auto_write") {
    await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
  }
  var safetyDecision = fabricated;`,
    ],
  ])("rejects a coalesced var binding with %s", async (_label, beforeKernel, guardBody) => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = importerWriterFixture(
      importsSource,
      guardBody,
      "safetyDecision",
      "",
      "var",
      beforeKernel,
    );

    expectSourceOverrideToTypecheck(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: packages/workspace/src/imports.ts");
  });

  it("rejects a nested block lexical shadow of a var kernel binding", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = importerWriterFixture(
      importsSource,
      `  {
    const safetyDecision: SafetyDecision = fabricated;
    if (safetyDecision.decision === "auto_write") {
      await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
    }
  }`,
      "safetyDecision",
      "",
      "var",
    );

    expectSourceOverrideToTypecheck(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: packages/workspace/src/imports.ts");
  });

  it("rejects an executable importer decoy when the real promotion writer is ungated", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource.replace("if (safetyDecision.decision === \"auto_write\")", "if (safetyDecision.decision !== \"auto_write\")")}
async function decoyPromotion(fileOps: ImportFileOps) {
  const workspaceRoot = "/workspace";
  const routed: RoutedDocument = {
    classification: {
      primaryCategory: "resource",
      alternativeCategories: [],
      sensitivity: "normal",
      confidence: 1,
      evidence: [],
      signals: [],
      conflict: false,
    },
    destination: "00-Inbox/Imports/decoy.md",
  };
  const stagingTargetPath = assertInsideWorkspace(workspaceRoot, ".app/import-staging/decoy.md");
  const safetyDecision = evaluateImportSafety({
    workspaceRoot,
    operation: "create",
    destination: routed.destination,
    destinationExists: false,
    autoWriteThreshold: 0.95,
    classification: routed.classification,
  });
  if (safetyDecision.decision === "auto_write") {
    const finalTargetPath = assertInsideWorkspace(workspaceRoot, routed.destination);
    await fileOps.writeFile(finalTargetPath, await fileOps.readFile(stagingTargetPath), true);
  }
}
`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: packages/workspace/src/imports.ts");
  });

  it("rejects an executable Review decoy when the real staged-note writer is ungated", async () => {
    const reviewPath = path.join(repoRoot, "apps/desktop/electron/ipc.ts");
    const reviewSource = await readFile(reviewPath, "utf8");
    const brokenReviewSource = `${reviewSource.replace("const safetyDecision = evaluateImportSafety({", "const safetyDecision = allowUnsafeMove({")}
function allowUnsafeMove(intent: Parameters<typeof evaluateImportSafety>[0]): SafetyDecision {
  return evaluateImportSafety(intent);
}

async function decoyReviewPromotion(
  workspaceRoot: string,
  approvedDestinationPath: string,
  approvedBody: string,
  fileOps: ReviewImportFileOps,
  application: { ioHooks?: IpcServices["reviewIoHooks"] },
  classification: ImportClassification,
) {
  const safetyDecision = evaluateImportSafety({
    workspaceRoot,
    operation: "move",
    destination: approvedDestinationPath,
    destinationExists: false,
    autoWriteThreshold: 0.95,
    classification,
    approval: {
      reviewItemId: "decoy",
      destination: approvedDestinationPath,
      classificationFingerprint: "decoy",
    },
  });
  if (safetyDecision.decision !== "auto_write") {
    throw new Error("blocked");
  }
  await securePublishWorkspaceFileAtomic(workspaceRoot, approvedDestinationPath, approvedBody, {
    operation: "destination_create",
    hooks: application.ioHooks,
  });
}
`;

    expectSourceOverrideToCompile(reviewPath, brokenReviewSource);

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[reviewPath, brokenReviewSource]]),
    });

    expect(result.failures).toContain("final import writer does not call the Safety Kernel: apps/desktop/electron/ipc.ts");
  });

  it("rejects an inverted Review auto_write equality guard", async () => {
    const reviewPath = path.join(repoRoot, "apps/desktop/electron/ipc.ts");
    const reviewSource = await readFile(reviewPath, "utf8");
    const brokenReviewSource = reviewSource.replace(
      /safetyDecision\.decision !== "auto_write"(?: \|\| safetyDecision\.allowedDestination === undefined)?/u,
      'safetyDecision.decision === "auto_write"',
    );

    expect(brokenReviewSource).toContain('if (safetyDecision.decision === "auto_write")');
    expectSourceOverrideToCompile(reviewPath, brokenReviewSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[reviewPath, brokenReviewSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: apps/desktop/electron/ipc.ts");
  });

  it("rejects a Review guard bound to a fabricated decision", async () => {
    const reviewPath = path.join(repoRoot, "apps/desktop/electron/ipc.ts");
    const reviewSource = await readFile(reviewPath, "utf8");
    const brokenReviewSource = `${reviewSource.replace(
      "const safetyDecision = evaluateImportSafety({",
      "const safetyDecision = fabricatedSafetyDecision(destination);\n  const unusedSafetyDecision = evaluateImportSafety({",
    )}
function fabricatedSafetyDecision(destination: string): SafetyDecision {
  return { decision: "auto_write", reasonCodes: [], allowedDestination: destination };
}
`;

    expectSourceOverrideToCompile(reviewPath, brokenReviewSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[reviewPath, brokenReviewSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: apps/desktop/electron/ipc.ts");
  });

  it("rejects a Review guard whose throw is conditional and nested", async () => {
    const reviewPath = path.join(repoRoot, "apps/desktop/electron/ipc.ts");
    const reviewSource = await readFile(reviewPath, "utf8");
    const brokenReviewSource = reviewSource.replace(
      /  if \(safetyDecision\.decision !== "auto_write"(?: \|\| safetyDecision\.allowedDestination === undefined)?\) \{\n    (throw new Error\(`Import approval \$\{safetyDecision\.decision\}: \$\{safetyDecision\.reasonCodes\.join\(", "\)\}`\);)\n  \}/u,
      "  if (safetyDecision.decision !== \"auto_write\") {\n    if (item.id === \"nested\") {\n      $1\n    }\n  }",
    );

    expect(brokenReviewSource).toContain('if (item.id === "nested")');
    expectSourceOverrideToCompile(reviewPath, brokenReviewSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[reviewPath, brokenReviewSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: apps/desktop/electron/ipc.ts");
  });

  it("rejects a second unconditional importer promotion write", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}
async function unsafeSecondPromotion(
  input: Parameters<typeof promoteImportArtifact>[0],
): Promise<void> {
  await promoteImportArtifact(input);
}
`;

    expect(brokenImportsSource.match(/promoteImportArtifact\(/g)).toHaveLength(2);
    expectSourceOverrideToTypecheck(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("final import writer does not call the Safety Kernel: packages/workspace/src/imports.ts");
  });

  it("rejects a second unconditional Review promotion write", async () => {
    const reviewPath = path.join(repoRoot, "apps/desktop/electron/ipc.ts");
    const reviewSource = await readFile(reviewPath, "utf8");
    const brokenReviewSource = reviewSource.replace(
      `  if (safetyDecision.decision !== "auto_write") {
    throw new Error(\`Import approval \${safetyDecision.decision}: \${safetyDecision.reasonCodes.join(", ")}\`);
  }
  if (safetyDecision.allowedDestination === undefined) {
    throw new Error("Import approval is missing an allowed destination");
  }

  const approvedDestinationPath = safetyDecision.allowedDestination;
  await assertRealPathInsideWorkspace(workspaceRoot, approvedDestinationPath);
  const approvedBody = destinationPath === approvedDestinationPath
    ? updatedBody
    : updateImportedSourceNoteRoute(body, sourcePath, approvedDestinationPath, destination, classification);`,
      `  const approvedDestinationPath: string = safetyDecision.allowedDestination ?? destinationPath ?? sourcePath;
  const approvedBody = destinationPath === approvedDestinationPath
    ? updatedBody
    : updateImportedSourceNoteRoute(body, sourcePath, approvedDestinationPath, destination, classification);
	  await securePublishWorkspaceFileAtomic(workspaceRoot, approvedDestinationPath, approvedBody, {
	    operation: "destination_create",
	    hooks: application.ioHooks,
	  });
  if (safetyDecision.decision !== "auto_write") {
    throw new Error(\`Import approval \${safetyDecision.decision}: \${safetyDecision.reasonCodes.join(", ")}\`);
  }
  if (safetyDecision.allowedDestination === undefined) {
    throw new Error("Import approval is missing an allowed destination");
  }

  await assertRealPathInsideWorkspace(workspaceRoot, approvedDestinationPath);`,
    );

    expect(brokenReviewSource).toContain("await securePublishWorkspaceFileAtomic(workspaceRoot, approvedDestinationPath, approvedBody, {");
    expectSourceOverrideToTypecheck(reviewPath, brokenReviewSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[reviewPath, brokenReviewSource]]),
    });

    expect(result.failures).toContain("final import writer is not gated on Safety Kernel auto_write: apps/desktop/electron/ipc.ts");
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

  it("fails for a quoted Review bypass property", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}\nconst unsafeRule = { "skipReview": true };\n`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("import routing source declares a Review bypass field: skipReview");
  });

  it("fails for a shorthand Review bypass property", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}\nconst skipReview = true;\nconst unsafeRule = { skipReview };\n`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("import routing source declares a Review bypass field: skipReview");
  });

  it("fails for an element-access Review bypass property", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}\nconst unsafeRule: Record<string, boolean> = {};\nunsafeRule["bypassReview"] = true;\n`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("import routing source declares a Review bypass field: bypassReview");
  });

  it("fails for a computed literal Review bypass property", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}\nconst unsafeRule = { ["skipReview"]: true };\n`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("import routing source declares a Review bypass field: skipReview");
  });

  it("follows a const string alias used as a computed Review bypass key", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}\nconst harmless = "skipReview";\nconst bypassKey = "bypassReview";\nconst unsafeRule = { [bypassKey]: true };\nvoid harmless;\n`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("import routing source declares a Review bypass field: skipReview");
  });

  it("fails for property access using the Review bypass identifier", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}\nconst unsafeRule: Record<string, boolean> = {};\nunsafeRule.skipReview = true;\n`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("import routing source declares a Review bypass field: skipReview");
  });

  it("fails for scoped const bypass keys without alias resolution", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}\n{ const firstKey = "skipReview"; void firstKey; }\n{ const secondKey = "skipReview"; void secondKey; }\n`;

    expectSourceOverrideToCompile(importsPath, brokenImportsSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[importsPath, brokenImportsSource]]),
    });

    expect(result.failures).toContain("import routing source declares a Review bypass field: skipReview");
  });

  it("fails when aliases, spreads, or string-key access carry a Review bypass", async () => {
    const importsPath = path.join(repoRoot, "packages/workspace/src/imports.ts");
    const importsSource = await readFile(importsPath, "utf8");
    const brokenImportsSource = `${importsSource}
const skipReview = true;
const reviewAlias = { skipReview };
const reviewRule = { ...reviewAlias, ["bypassReview"]: true };
void reviewRule["skipReview"];
`;

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

  it("rejects a decoy runtime-directory guard when index traversal includes staging", async () => {
    const indexerPath = path.join(repoRoot, "packages/workspace/src/indexer.ts");
    const indexerSource = await readFile(indexerPath, "utf8");
    const brokenIndexerSource = `${indexerSource
      .replace("if (shouldSkipDirectory(entry.name))", "if (shouldSkipDirectoryForResources(entry.name))")
      .replace("function shouldSkipDirectory(name", "function shouldSkipDirectoryForResources(name")
      .replace('name === ".app"', 'name === ".runtime"')}
function shouldSkipDirectory(name: string): boolean {
  return name === ".app";
}
void shouldSkipDirectory(".app");
`;

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[indexerPath, brokenIndexerSource]]),
    });

    expect(result.failures).toContain("indexer does not exclude runtime staging from indexing");
  });

  it("rejects a no-op staging predicate call before recursive indexing", async () => {
    const indexerPath = path.join(repoRoot, "packages/workspace/src/indexer.ts");
    const indexerSource = await readFile(indexerPath, "utf8");
    const brokenIndexerSource = indexerSource.replace(
      "      if (shouldSkipDirectory(entry.name)) {\n        continue;\n      }",
      "      shouldSkipDirectory(entry.name);",
    );

    expectSourceOverrideToCompile(indexerPath, brokenIndexerSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[indexerPath, brokenIndexerSource]]),
    });

    expect(result.failures).toContain("indexer does not exclude runtime staging from indexing");
  });

  it("rejects a no-op .app comparison in the skip predicate", async () => {
    const indexerPath = path.join(repoRoot, "packages/workspace/src/indexer.ts");
    const indexerSource = await readFile(indexerPath, "utf8");
    const brokenIndexerSource = indexerSource.replace(
      'return name === ".app" || name === "06-Attachments" || name === "node_modules" || name.startsWith(".");',
      'name === ".app";\n  return name === "06-Attachments" || name === "node_modules" || name.startsWith(".");',
    );

    expectSourceOverrideToCompile(indexerPath, brokenIndexerSource);
    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[indexerPath, brokenIndexerSource]]),
    });

    expect(result.failures).toContain("indexer does not exclude runtime staging from indexing");
  });

  it("rejects a staging guard whose continue belongs to an inner loop", async () => {
    const indexerPath = path.join(repoRoot, "packages/workspace/src/indexer.ts");
    const indexerSource = await readFile(indexerPath, "utf8");
    const brokenIndexerSource = indexerSource.replace(
      "      if (shouldSkipDirectory(entry.name)) {\n        continue;\n      }",
      "      if (shouldSkipDirectory(entry.name)) {\n        for (const ignored of [entry.name]) {\n          continue;\n        }\n      }",
    );

    expectSourceOverrideToTypecheck(indexerPath, brokenIndexerSource);
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
      const extractorsSource = await readFile(path.join(repoRoot, "packages/workspace/src/importExtractors.ts"), "utf8");
      const promotionSource = await readFile(path.join(repoRoot, "packages/workspace/src/importPromotion.ts"), "utf8");
      const secureIoSource = await readFile(path.join(repoRoot, "packages/workspace/src/secureWorkspaceIo.ts"), "utf8");
      const writeLockSource = await readFile(path.join(repoRoot, "packages/workspace/src/workspaceWriteLock.ts"), "utf8");
      const importRoutingSource = await readFile(path.join(repoRoot, "packages/workspace/src/importCandidateRoutingPolicy.ts"), "utf8");
      const workspaceSource = await readFile(path.join(repoRoot, "packages/workspace/src/workspace.ts"), "utf8");
      const indexerSource = await readFile(path.join(repoRoot, "packages/workspace/src/indexer.ts"), "utf8");
      const ipcSource = await readFile(path.join(repoRoot, "apps/desktop/electron/ipc.ts"), "utf8");
      await writeFile(path.join(tempRoot, "packages/workspace/src/templates.ts"), contractSource);
      await writeFile(path.join(tempRoot, "packages/workspace/src/imports.ts"), importsSource);
      await writeFile(path.join(tempRoot, "packages/workspace/src/importExtractors.ts"), extractorsSource);
      await writeFile(path.join(tempRoot, "packages/workspace/src/importPromotion.ts"), promotionSource);
      await writeFile(path.join(tempRoot, "packages/workspace/src/secureWorkspaceIo.ts"), secureIoSource);
      await writeFile(path.join(tempRoot, "packages/workspace/src/workspaceWriteLock.ts"), writeLockSource);
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
