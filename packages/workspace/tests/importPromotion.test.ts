import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
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

  it("never exposes a journal or final file after a partial journal temp write", async () => {
    const setup = await promotionSetup();

    await expect(promoteImportArtifact({
      ...setup.intent,
      hooks: {
        afterDurableStep: async (step) => {
          if (step === "journal_temp_partial") {
            throw new Error("crash during journal temp write");
          }
        },
      },
    })).rejects.toThrow("crash during journal temp write");

    await expect(access(path.join(setup.root, setup.intent.finalPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await journalFiles(setup.root)).filter((name) => name.endsWith(".json"))).toEqual([]);
    await recoverImportPromotions(setup.root);
    expect((await journalFiles(setup.root)).filter((name) => name.includes(".tmp"))).toEqual([]);
    await expect(readFile(path.join(setup.root, setup.intent.stagingPath), "utf8")).resolves.toBe(setup.body);
  });

  it("recovers deterministically from crashes immediately before and after final publication", async () => {
    for (const crashStep of ["final_temp_synced", "final_published"] as const) {
      const setup = await promotionSetup();

      await expect(promoteImportArtifact({
        ...setup.intent,
        hooks: {
          afterDurableStep: async (step) => {
            if (step === crashStep) {
              throw new Error(`crash at ${crashStep}`);
            }
          },
        },
      })).rejects.toThrow(`crash at ${crashStep}`);

      if (crashStep === "final_temp_synced") {
        await expect(access(path.join(setup.root, setup.intent.finalPath))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(readFile(path.join(setup.root, setup.intent.finalPath), "utf8")).resolves.toBe(setup.body);
        const journal = await readOnlyFinalJournal(setup.root);
        expect(journal).toEqual(expect.objectContaining({
          phase: "final_published",
          final: expect.objectContaining({
            dev: expect.any(Number),
            ino: expect.any(Number),
            sha256: createHash("sha256").update(setup.body).digest("hex"),
          }),
        }));
      }

      await recoverImportPromotions(setup.root);
      await expect(readFile(path.join(setup.root, setup.intent.finalPath), "utf8")).resolves.toBe(setup.body);
      await expect(access(path.join(setup.root, setup.intent.stagingPath))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("quarantines malformed journals without blocking valid recovery and cleans temp journals", async () => {
    const setup = await promotionSetup();
    await expect(promoteImportArtifact({
      ...setup.intent,
      hooks: {
        afterDurableStep: async (step) => {
          if (step === "journal_synced") {
            throw new Error("leave valid journal");
          }
        },
      },
    })).rejects.toThrow("leave valid journal");
    const journalDir = path.join(setup.root, ".app/import-promotion-journal");
    await writeFile(path.join(journalDir, "broken.json"), "{not-json", "utf8");
    await writeFile(path.join(journalDir, ".partial.json.123.tmp"), "partial", "utf8");

    await expect(recoverImportPromotions(setup.root)).resolves.toBeUndefined();

    await expect(readFile(path.join(setup.root, setup.intent.finalPath), "utf8")).resolves.toBe(setup.body);
    const names = await journalFiles(setup.root);
    expect(names.some((name) => name.includes("broken.json") && name.includes("malformed"))).toBe(true);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(names.some((name) => name.endsWith(".json"))).toBe(false);
  });

  it.each(["edited", "replaced"] as const)(
    "rolls back only its final and preserves %s staging after publication",
    async (mutation) => {
      const setup = await promotionSetup();
      const stagingPath = path.join(setup.root, setup.intent.stagingPath);
      const newerBody = `${setup.body}\nNewer staged edit.\n`;

      await expect(promoteImportArtifact({
        ...setup.intent,
        hooks: {
          afterDurableStep: async (step) => {
            if (step !== "final_published") {
              return;
            }
            if (mutation === "replaced") {
              await rename(stagingPath, `${stagingPath}.previous`);
            }
            await writeFile(stagingPath, newerBody, "utf8");
          },
        },
      })).rejects.toThrow(/staging artifact changed/iu);

      await expect(access(path.join(setup.root, setup.intent.finalPath))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(stagingPath, "utf8")).resolves.toBe(newerBody);
    },
  );

  it("rolls back its final when the bound attachment changes before staging retirement", async () => {
    const setup = await promotionSetup();

    await expect(promoteImportArtifact({
      ...setup.intent,
      hooks: {
        afterDurableStep: async (step) => {
          if (step === "final_published") {
            await writeFile(
              path.join(setup.root, setup.intent.sourcePath),
              "changed attachment bytes",
              "utf8",
            );
          }
        },
      },
    })).rejects.toThrow(/attachment changed/iu);

    await expect(access(path.join(setup.root, setup.intent.finalPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(setup.root, setup.intent.stagingPath), "utf8")).resolves.toBe(setup.body);
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
  const body = `---
title: Recovered Source
type: resource
status: pending_review
owner: default
scope: personal
sensitivity: normal
created: 2026-07-29
tags: [imported, pending-review]
source_type: import
source_file: ../06-Attachments/Imports/Crash/Source.txt
route_status: pending_review
route_destination: 03-Knowledge/Recovered Source.md
---

# Recovered source

Exact authoritative bytes.
`;
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

async function readOnlyFinalJournal(root: string): Promise<Record<string, unknown>> {
  const journalDir = path.join(root, ".app/import-promotion-journal");
  const finalJournals = (await readdir(journalDir)).filter((name) => name.endsWith(".json"));
  expect(finalJournals).toHaveLength(1);
  return JSON.parse(await readFile(path.join(journalDir, finalJournals[0]!), "utf8")) as Record<string, unknown>;
}
