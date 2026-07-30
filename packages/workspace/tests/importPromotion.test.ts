import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  importDocumentBatch,
  promoteImportArtifact,
  recoverImportPromotions,
} from "../src/index";

describe("durable import promotion", () => {
  it("recovers a crash after the journal is durable but before the final write", async () => {
    const setup = await promotionSetup();

    await expect(promoteImportArtifact({
      ...setup.intent,
      hooks: {
        afterDurableStep: async (step) => {
          if (step === "journal_synced") {
            throw new Error("simulated process crash");
          }
        },
      },
    })).rejects.toThrow("simulated process crash");

    await expect(access(path.join(setup.root, setup.intent.finalPath))).rejects.toMatchObject({ code: "ENOENT" });
    await recoverImportPromotions(setup.root);

    await expect(readFile(path.join(setup.root, setup.intent.finalPath), "utf8")).resolves.toBe(setup.body);
    await expect(access(path.join(setup.root, setup.intent.stagingPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await journalFiles(setup.root)).toEqual([]);
  });

  it("chooses the exact final file as authority after a crash leaves both files", async () => {
    const setup = await promotionSetup();

    await expect(promoteImportArtifact({
      ...setup.intent,
      hooks: {
        afterDurableStep: async (step) => {
          if (step === "final_synced") {
            throw new Error("simulated process crash");
          }
        },
      },
    })).rejects.toThrow("simulated process crash");

    await expect(readFile(path.join(setup.root, setup.intent.stagingPath), "utf8")).resolves.toBe(setup.body);
    await expect(readFile(path.join(setup.root, setup.intent.finalPath), "utf8")).resolves.toBe(setup.body);
    await recoverImportPromotions(setup.root);

    await expect(readFile(path.join(setup.root, setup.intent.finalPath), "utf8")).resolves.toBe(setup.body);
    await expect(access(path.join(setup.root, setup.intent.stagingPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await journalFiles(setup.root)).toEqual([]);
  });

  it("fails closed when a crash destination collides with different content", async () => {
    const setup = await promotionSetup();
    await writeJournal(setup);
    await mkdir(path.dirname(path.join(setup.root, setup.intent.finalPath)), { recursive: true });
    await writeFile(path.join(setup.root, setup.intent.finalPath), "unrelated authority", "utf8");

    await expect(recoverImportPromotions(setup.root)).rejects.toThrow(
      "Promotion destination does not match its journal hash",
    );

    await expect(readFile(path.join(setup.root, setup.intent.stagingPath), "utf8")).resolves.toBe(setup.body);
    await expect(readFile(path.join(setup.root, setup.intent.finalPath), "utf8")).resolves.toBe("unrelated authority");
    expect(await journalFiles(setup.root)).toHaveLength(1);
  });

  it("does not follow a symlinked final parent while recovering", async () => {
    const setup = await promotionSetup();
    const outside = await mkdtemp(path.join(tmpdir(), "kb-agent-promotion-outside-"));
    await writeJournal(setup);
    await symlink(outside, path.join(setup.root, "03-Knowledge"), "dir");

    await expect(recoverImportPromotions(setup.root)).rejects.toThrow(/outside workspace|symbolic link/iu);

    expect(await readdir(outside)).toEqual([]);
    await expect(readFile(path.join(setup.root, setup.intent.stagingPath), "utf8")).resolves.toBe(setup.body);
  });

  it("recovers pending promotions before starting another import", async () => {
    const setup = await promotionSetup();
    await writeJournal(setup);
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-promotion-source-"));
    const nextSource = path.join(sourceDir, "Next.txt");
    await writeFile(nextSource, "A separate import.", "utf8");

    const job = await importDocumentBatch({
      workspaceRoot: setup.root,
      batchName: "Next",
      files: [nextSource],
      now: "2026-07-29T03:00:00.000Z",
    });

    expect(job.state).toBe("completed");
    await expect(readFile(path.join(setup.root, setup.intent.finalPath), "utf8")).resolves.toBe(setup.body);
    await expect(access(path.join(setup.root, setup.intent.stagingPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await journalFiles(setup.root)).toEqual([]);
  });
});

async function promotionSetup(): Promise<{
  root: string;
  body: string;
  intent: {
    workspaceRoot: string;
    sourcePath: string;
    stagingPath: string;
    finalPath: string;
  };
}> {
  const root = await mkdtemp(path.join(tmpdir(), "kb-agent-promotion-"));
  const sourcePath = "06-Attachments/Imports/Crash/Source.txt";
  const stagingPath = ".app/import-staging/crash/Source.md";
  const finalPath = "03-Knowledge/Recovered Source.md";
  const body = "# Recovered source\n\nExact authoritative bytes.\n";
  await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await mkdir(path.dirname(path.join(root, stagingPath)), { recursive: true });
  await writeFile(path.join(root, sourcePath), "Original source bytes.", "utf8");
  await writeFile(path.join(root, stagingPath), body, "utf8");
  return {
    root,
    body,
    intent: { workspaceRoot: root, sourcePath, stagingPath, finalPath },
  };
}

async function writeJournal(setup: Awaited<ReturnType<typeof promotionSetup>>): Promise<void> {
  const journalDir = path.join(setup.root, ".app/import-promotion-journal");
  await mkdir(journalDir, { recursive: true });
  await writeFile(
    path.join(journalDir, "manual-crash.json"),
    `${JSON.stringify({
      version: 1,
      sourcePath: setup.intent.sourcePath,
      stagingPath: setup.intent.stagingPath,
      finalPath: setup.intent.finalPath,
      contentHash: createHash("sha256").update(setup.body).digest("hex"),
    })}\n`,
    "utf8",
  );
}

async function journalFiles(root: string): Promise<string[]> {
  return readdir(path.join(root, ".app/import-promotion-journal")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
}
