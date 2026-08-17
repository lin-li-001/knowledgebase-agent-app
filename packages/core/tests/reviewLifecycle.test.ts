import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyReviewItem, transitionReviewState } from "../src/index";
import { importedSourceBodyHash, wrapImportedSourceBody } from "@kb-agent/workspace";

describe("review lifecycle", () => {
  it("allows valid transitions", () => {
    expect(transitionReviewState("proposed", "approved")).toBe("approved");
    expect(transitionReviewState("proposed", "rejected")).toBe("rejected");
    expect(transitionReviewState("proposed", "superseded")).toBe("superseded");
    expect(transitionReviewState("approved", "applied")).toBe("applied");
    expect(transitionReviewState("approved", "failed")).toBe("failed");
    expect(transitionReviewState("proposed", "applying")).toBe("applying");
    expect(transitionReviewState("applying", "applied")).toBe("applied");
    expect(transitionReviewState("proposed", "rejecting")).toBe("rejecting");
    expect(transitionReviewState("rejecting", "rejected")).toBe("rejected");
    expect(transitionReviewState("failed", "applying")).toBe("applying");
    expect(transitionReviewState("failed", "proposed")).toBe("proposed");
  });

  it("rejects invalid transitions", () => {
    expect(() => transitionReviewState("rejected", "applied")).toThrow("Invalid review transition");
  });

  it("applies replace_body patches when the base hash matches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-review-"));
    const targetPath = path.join(root, "Note.md");
    await writeFile(targetPath, "old body", "utf8");

    const applied = await applyReviewItem({
      id: "review-1",
      state: "approved",
      targetPath,
      patch: {
        kind: "replace_body",
        baseContentHash: hash("old body"),
        nextBody: "new body",
      },
    }, root);

    expect(applied.state).toBe("applied");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("new body");
  });

  it("fails stale patches without writing the file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-review-"));
    const targetPath = path.join(root, "Note.md");
    await writeFile(targetPath, "changed body", "utf8");

    const failed = await applyReviewItem({
      id: "review-1",
      state: "approved",
      targetPath,
      patch: {
        kind: "replace_body",
        baseContentHash: hash("old body"),
        nextBody: "new body",
      },
    }, root);

    expect(failed.state).toBe("failed");
    expect(failed.failureReason).toBe("Target changed since proposal");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("changed body");
  });

  it("rejects generic patches that rewrite an imported source body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-review-"));
    const targetPath = path.join(root, "Resume.md");
    const sourceBody = "Original resume evidence.";
    const current = importedSourceNote(sourceBody);
    const changed = importedSourceNote("Rewritten resume evidence.", importedSourceBodyHash(sourceBody));
    await writeFile(targetPath, current, "utf8");

    await expect(applyReviewItem({
      id: "review-source-rewrite",
      state: "approved",
      targetPath,
      patch: {
        kind: "replace_body",
        baseContentHash: hash(current),
        nextBody: changed,
      },
    }, root)).rejects.toThrow("Imported source body cannot be modified");
    await expect(readFile(targetPath, "utf8")).resolves.toBe(current);
  });

  it("rejects patches outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-review-"));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "kb-agent-review-outside-"));
    const targetPath = path.join(outsideRoot, "Note.md");
    await writeFile(targetPath, "old body", "utf8");

    await expect(
      applyReviewItem({
        id: "review-1",
        state: "approved",
        targetPath,
        patch: {
          kind: "replace_body",
          baseContentHash: hash("old body"),
          nextBody: "new body",
        },
      }, root),
    ).rejects.toThrow("Path escapes workspace");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("old body");
  });
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function importedSourceNote(body: string, bodyHash = importedSourceBodyHash(body)): string {
  return `---
title: Resume
type: resource
status: approved
owner: default
scope: personal
sensitivity: personal
created: 2026-08-16
tags: [imported]
source_type: import
source_file: Resume.pdf
source_sha256: ${"a".repeat(64)}
source_body_sha256: ${bodyHash}
source_integrity: source_evidence
extraction_version: 1
---

# Resume

## Document

${wrapImportedSourceBody(body)}
`;
}
