import { describe, expect, it } from "vitest";
import { buildRequestMessages } from "../src/index";

describe("buildRequestMessages", () => {
  it("injects retrieved snippets into the current user message without mutating history", () => {
    const history = [{ role: "user" as const, content: "old message" }];

    const messages = buildRequestMessages(history, "What is graph memory?", [
      {
        title: "Graph Memory",
        path: "03-Knowledge/Graph Memory.md",
        text: "Graph memory architecture",
        snippet: "Graph memory architecture",
      },
    ]);

    expect(history).toEqual([{ role: "user", content: "old message" }]);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain("Relevant local context");
    expect(messages[1]?.content).toContain("Source: 03-Knowledge/Graph Memory.md");
    expect(messages[1]?.content).toContain("Evidence: Graph memory architecture");
    expect(messages[1]?.content).toContain("Response style");
    expect(messages[1]?.content).toContain("Use short Markdown sections");
  });
});
