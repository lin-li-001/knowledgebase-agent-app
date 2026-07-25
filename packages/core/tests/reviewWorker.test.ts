import { describe, expect, it } from "vitest";
import { MockProvider } from "@kb-agent/model";
import { isReviewEligible, reviewWorkerPrompt, runReviewJob, type CompletedTurn } from "../src/index";
import type { ToolHandler } from "../src/tools/toolExecutor";
import type { MvpToolName } from "../src/tools/toolRegistry";

const baseTurn: CompletedTurn = {
  id: "turn-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  userMessage: "Remember that I prefer Activity Feed over toast.",
  assistantMessage: "I will remember that preference.",
  state: "completed",
};

describe("review worker", () => {
  it("recognizes eligible completed turns", () => {
    expect(isReviewEligible(baseTurn)).toBe(true);
    expect(isReviewEligible({ ...baseTurn, userMessage: "We decided to keep imports in 04-Resources/Imports." })).toBe(true);
    expect(isReviewEligible({ ...baseTurn, userMessage: "Please import these utility bills and summarize them." })).toBe(true);
    expect(isReviewEligible({ ...baseTurn, userMessage: "hello my name is lin li" })).toBe(true);
    expect(isReviewEligible({ ...baseTurn, userMessage: "I have two kids, Grace and Leo." })).toBe(true);
  });

  it("skips ineligible turns", () => {
    expect(isReviewEligible({ ...baseTurn, state: "interrupted" })).toBe(false);
    expect(isReviewEligible({ ...baseTurn, state: "error" })).toBe(false);
    expect(isReviewEligible({ ...baseTurn, userMessage: "   " })).toBe(false);
    expect(isReviewEligible({ ...baseTurn, userMessage: "where did I work in 2018?" })).toBe(false);
    expect(isReviewEligible({ ...baseTurn, userMessage: "thanks" })).toBe(false);
    expect(isReviewEligible({ ...baseTurn, reviewedAt: "2026-07-21T00:00:00.000Z" })).toBe(false);
  });

  it("uses a constrained prompt with memory, notes, sessions, activity, and review layers", () => {
    const prompt = reviewWorkerPrompt(baseTurn);

    expect(prompt).toContain("curated memory");
    expect(prompt).toContain("notes");
    expect(prompt).toContain("session history");
    expect(prompt).toContain("activity");
    expect(prompt).toContain("review items");
    expect(prompt).toContain("Do not save task progress");
    expect(prompt).toContain("raw transcript excerpts");
    expect(prompt).toContain("source");
    expect(prompt).toContain("turn_reflection");
    expect(prompt).toContain("Stable personal facts");
  });

  it("creates a high-risk memory proposal for stable preferences", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const handlers = new Map<MvpToolName, ToolHandler>([
      ["propose_memory", async (input) => {
        calls.push({ name: "propose_memory", input });
        return { reviewItemId: "review-1" };
      }],
    ]);
    const provider = new MockProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "propose_memory",
            argumentsJson: JSON.stringify({
              body: "User prefers Activity Feed over toast for auto-save feedback.",
              source: {
                origin: "turn_reflection",
                userMessage: baseTurn.userMessage,
                assistantMessage: baseTurn.assistantMessage,
                reason: "Stable product preference.",
              },
            }),
          },
        ],
      },
    ]);

    await expect(runReviewJob({ turn: baseTurn, modelProvider: provider, model: "mock", handlers })).resolves.toEqual({
      state: "reviewed",
      toolCalls: ["propose_memory"],
    });
    expect(calls).toEqual([
      {
        name: "propose_memory",
        input: {
          body: "User prefers Activity Feed over toast for auto-save feedback.",
          source: {
            origin: "turn_reflection",
            userMessage: baseTurn.userMessage,
            assistantMessage: baseTurn.assistantMessage,
            reason: "Stable product preference.",
          },
        },
      },
    ]);
  });

  it("rejects unsafe worker tool calls", async () => {
    const provider = new MockProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "propose_delete",
            argumentsJson: "{\"path\":\"03-Knowledge/Old.md\"}",
          },
        ],
      },
    ]);

    await expect(runReviewJob({ turn: baseTurn, modelProvider: provider, model: "mock", handlers: new Map() })).rejects.toThrow(
      "Review worker cannot call tool: propose_delete",
    );
  });
});
