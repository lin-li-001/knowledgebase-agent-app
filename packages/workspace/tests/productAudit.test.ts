import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditProductContracts } from "../src/index";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

describe("product audit", () => {
  it("checks product contract drift in the current repo", async () => {
    const result = await auditProductContracts({ repoRoot });

    expect(result.failures).toEqual([]);
    expect(result.passes).toContain("routing policy paths are documented in the workspace contract");
    expect(result.passes).toContain("filesystem writers use routingPolicy instead of route literals");
    expect(result.warnings).toContain("implementation repo has no docs/decisions ADR mirror yet");
  });

  it("fails when the workspace contract disagrees with routing policy paths", async () => {
    const contractPath = path.join(repoRoot, "packages/workspace/src/templates.ts");
    const contractSource = await readFile(contractPath, "utf8");
    const brokenContractSource = contractSource.replace("04-Resources/Imports/<batch-name>.md", "03-Knowledge/Imports/<batch-name>.md");

    const result = await auditProductContracts({
      repoRoot,
      sourceOverrides: new Map([[contractPath, brokenContractSource]]),
    });

    expect(result.failures).toContain("workspace contract is missing import summary route 04-Resources/Imports/<batch-name>.md");
  });
});
