import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyReviewItem, transitionReviewState } from "../src/index";

describe("review lifecycle", () => {
  it("allows valid transitions", () => {
    expect(transitionReviewState("proposed", "approved")).toBe("approved");
    expect(transitionReviewState("proposed", "rejected")).toBe("rejected");
    expect(transitionReviewState("proposed", "superseded")).toBe("superseded");
    expect(transitionReviewState("approved", "applied")).toBe("applied");
    expect(transitionReviewState("approved", "failed")).toBe("failed");
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
    });

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
    });

    expect(failed.state).toBe("failed");
    expect(failed.failureReason).toBe("Target changed since proposal");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("changed body");
  });
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
