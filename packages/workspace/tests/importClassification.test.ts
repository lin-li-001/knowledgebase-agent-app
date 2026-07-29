import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectImportSignals,
  mergeImportClassification,
  type ClassificationSignal,
} from "../src/index";
import { importDocumentBatch } from "../src/imports";

describe("detectImportSignals", () => {
  it("emits finance evidence without retaining the whole document", () => {
    const signals = detectImportSignals({
      batchName: "2026 Utility Bill",
      fileName: "PG&E.pdf",
      text: "Amount due $184.27",
    });

    expect(signals).toContainEqual(expect.objectContaining({
      source: "detector",
      category: "finance.utility",
      sensitivity: "personal",
      evidence: expect.arrayContaining(["Amount due $184.27"]),
    }));
  });

  it("emits personal, certain employment facts with their matched line", () => {
    const signals = detectImportSignals({
      batchName: "Career history",
      fileName: "Resume.txt",
      text: "Summary\nStaff Engineer | OpenAI Jan 2024 - Present\nSelected work",
    });

    expect(signals).toContainEqual(expect.objectContaining({
      source: "detector",
      category: "profile.career",
      sensitivity: "personal",
      confidence: 1,
      evidence: ["Staff Engineer | OpenAI Jan 2024 - Present"],
    }));
  });

  it("caps every stored evidence snippet at 240 characters", () => {
    const amountDue = `Amount due $184.27 ${"x".repeat(300)}`;
    const signals = detectImportSignals({
      batchName: "Utility bill",
      fileName: "bill.txt",
      text: amountDue,
    });

    expect(signals.flatMap((signal) => signal.evidence).every((evidence) => evidence.length <= 240)).toBe(true);
  });
});

describe("mergeImportClassification", () => {
  it("gives saved user category and destination precedence while retaining detector safety evidence", () => {
    const detector: ClassificationSignal = {
      source: "detector",
      category: "finance.utility",
      sensitivity: "personal",
      confidence: 0.8,
      destination: "02-Personal/default/Finance/Utilities/2026/Bill.md",
      evidence: ["Amount due $184.27"],
    };
    const model: ClassificationSignal = {
      source: "model",
      category: "resource",
      sensitivity: "normal",
      confidence: 0.95,
      destination: "04-Resources/Model.md",
      evidence: ["Model label"],
    };
    const savedRule: ClassificationSignal = {
      source: "saved_user_policy",
      category: "resource",
      destination: "03-Knowledge/Saved Rule.md",
      evidence: ["Rule: utility bills"],
    };

    const classification = mergeImportClassification({
      signals: [model, detector, savedRule],
      fallbackDestination: "00-Inbox/Imports/Utility Bill.md",
    });

    expect(classification).toMatchObject({
      primaryCategory: "resource",
      sensitivity: "personal",
      confidence: 1,
      suggestedDestination: "03-Knowledge/Saved Rule.md",
      conflict: false,
    });
    expect(classification.evidence).toContain("Amount due $184.27");
    expect(classification.signals).toContainEqual(detector);
  });

  it("orders current overrides, saved rules, detectors, models, then fallback", () => {
    const classification = mergeImportClassification({
      signals: [
        { source: "model", category: "resource", destination: "model.md", evidence: [] },
        { source: "detector", category: "finance.utility", destination: "detector.md", evidence: [] },
        { source: "saved_user_policy", category: "profile.career", destination: "saved.md", evidence: [] },
        { source: "current_user_override", category: "project.document", destination: "override.md", evidence: [] },
      ],
      fallbackDestination: "fallback.md",
    });

    expect(classification.primaryCategory).toBe("project.document");
    expect(classification.suggestedDestination).toBe("override.md");
    expect(classification.confidence).toBe(1);
  });

  it("sets a conflict for incompatible equal-priority categories", () => {
    const classification = mergeImportClassification({
      signals: [
        { source: "detector", category: "finance.utility", evidence: ["Bill"] },
        { source: "detector", category: "profile.career", evidence: ["Employment"] },
      ],
      fallbackDestination: "00-Inbox/Imports/mixed.md",
    });

    expect(classification).toMatchObject({
      primaryCategory: "finance.utility",
      alternativeCategories: ["profile.career"],
      conflict: true,
    });
  });

  it("uses the strictest sensitivity even when it comes from a lower-priority signal", () => {
    const classification = mergeImportClassification({
      signals: [
        { source: "current_user_override", category: "resource", sensitivity: "normal", evidence: [] },
        { source: "model", category: "resource", sensitivity: "restricted", evidence: ["Sensitive model evidence"] },
      ],
      fallbackDestination: "00-Inbox/Imports/document.md",
    });

    expect(classification.sensitivity).toBe("restricted");
    expect(classification.evidence).toContain("Sensitive model evidence");
  });

  it("falls back to unknown category and the supplied destination", () => {
    expect(mergeImportClassification({ signals: [], fallbackDestination: "00-Inbox/Imports/document.md" })).toMatchObject({
      primaryCategory: "unknown",
      sensitivity: "normal",
      confidence: 0,
      suggestedDestination: "00-Inbox/Imports/document.md",
      conflict: false,
    });
  });
});

describe("saved import rules", () => {
  it("keeps saved user policies in Review even when their classification is normal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-classification-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-classification-source-"));
    const sourcePath = path.join(sourceDir, "Project Brief.txt");
    await mkdir(path.join(root, ".vault"), { recursive: true });
    await writeFile(sourcePath, "Product planning notes", "utf8");
    await writeFile(
      path.join(root, ".vault/routing-policy.json"),
      JSON.stringify({
        rules: [{
          pattern: "project brief",
          category: "resource",
          sensitivity: "normal",
          destination: "03-Knowledge/Project Brief.md",
        }],
      }),
      "utf8",
    );

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "Project Brief",
      files: [sourcePath],
      now: "2026-07-29T00:00:00.000Z",
    });

    expect(job.notes[0]).toMatchObject({
      destination: "03-Knowledge/Project Brief.md",
      routeStatus: "pending_review",
      risk: "high",
    });
  });

  it("keeps a valid legacy destination when optional classification values are invalid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-import-classification-"));
    const sourceDir = await mkdtemp(path.join(tmpdir(), "kb-agent-import-classification-source-"));
    const sourcePath = path.join(sourceDir, "Utility Bill.txt");
    await mkdir(path.join(root, ".vault"), { recursive: true });
    await writeFile(sourcePath, "Monthly utility bill\nAmount due $184.27", "utf8");
    await writeFile(
      path.join(root, ".vault/routing-policy.json"),
      JSON.stringify({
        rules: [{
          pattern: "utility bill",
          destination: "03-Knowledge/Utility Bills.md",
          category: "not-a-category",
          sensitivity: "very-private",
        }],
      }),
      "utf8",
    );

    const job = await importDocumentBatch({
      workspaceRoot: root,
      batchName: "2026 Utility Bills",
      files: [sourcePath],
      now: "2026-07-29T00:00:00.000Z",
    });

    expect(job).toMatchObject({
      state: "completed",
      notes: [expect.objectContaining({
        destination: "03-Knowledge/Utility Bills.md",
        routeStatus: "pending_review",
      })],
    });
    await expect(readFile(path.join(root, job.notes[0]!.notePath), "utf8")).resolves.toContain(
      "Destination: 03-Knowledge/Utility Bills.md",
    );
  });
});
