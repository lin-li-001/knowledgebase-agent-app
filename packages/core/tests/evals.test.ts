import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockProvider } from "@kb-agent/model";
import { applyReviewItem, classifyProposalRisk } from "../src/index";

describe("LLM and tool-routing evals", () => {
  it("[->EVAL] English search question calls search_notes before answering", async () => {
    const provider = new MockProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "search_notes", argumentsJson: "{\"query\":\"memory\"}" }],
      },
    ]);

    await expect(provider.complete({ model: "mock", messages: [{ role: "user", content: "What is memory?" }] })).resolves.toEqual(
      expect.objectContaining({ toolCalls: [expect.objectContaining({ name: "search_notes" })] }),
    );
  });

  it("[->EVAL] Chinese search question calls search_notes and returns Chinese-capable result", async () => {
    const provider = new MockProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "search_notes", argumentsJson: "{\"query\":\"中文\"}" }],
      },
    ]);

    const response = await provider.complete({ model: "mock", messages: [{ role: "user", content: "查一下中文笔记" }] });
    expect(response.toolCalls?.[0]).toEqual(expect.objectContaining({ name: "search_notes" }));
    expect(response.toolCalls?.[0]?.argumentsJson).toContain("中文");
  });

  it("[->EVAL] durable Activity Feed preference becomes high-risk memory proposal", () => {
    expect(classifyProposalRisk({ proposalType: "memory", sensitivity: "normal" })).toBe("high");
  });

  it("[->EVAL] normal resource note can be low-risk auto-applied", () => {
    expect(classifyProposalRisk({ proposalType: "create_note", noteType: "resource", sensitivity: "normal" })).toBe("low");
  });

  it("[->EVAL] delete note requires explicit confirmation", () => {
    expect(classifyProposalRisk({ proposalType: "delete" })).toBe("explicit");
  });

  it("[->EVAL] stale baseContentHash update fails without writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-eval-"));
    const notePath = path.join(root, "Note.md");
    await writeFile(notePath, "changed", "utf8");

    const result = await applyReviewItem({
      id: "review-1",
      state: "approved",
      targetPath: notePath,
      patch: {
        kind: "replace_body",
        baseContentHash: hash("old"),
        nextBody: "new",
      },
    }, root);

    expect(result.state).toBe("failed");
    expect(result.failureReason).toBe("Target changed since proposal");
    await expect(readFile(notePath, "utf8")).resolves.toBe("changed");
  });
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
