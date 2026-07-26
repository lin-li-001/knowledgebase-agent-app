import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTurnContext, type RecallProvider } from "../src/index";
import type { AppDatabase } from "@kb-agent/storage";

describe("buildTurnContext", () => {
  it("collects evidence from pluggable recall providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-context-"));
    const provider: RecallProvider = {
      name: "test-memory",
      async prefetch(input) {
        expect(input.query).toBe("what should you remember about me?");
        return [
          {
            provider: "test-memory",
            sourceType: "memory",
            title: "Default memory",
            path: "02-Profiles/default/Memory.md",
            text: "User prefers review before durable memory writes.",
            snippet: "review before durable memory writes",
            matchedFields: ["body"],
          },
        ];
      },
    };

    const context = await buildTurnContext({
      db: {} as AppDatabase,
      workspaceId: "workspace-1",
      workspaceRoot: root,
      query: "what should you remember about me?",
      recallProviders: [provider],
    });

    expect(context.evidence).toEqual([
      {
        provider: "test-memory",
        sourceType: "memory",
        title: "Default memory",
        path: "02-Profiles/default/Memory.md",
        text: "User prefers review before durable memory writes.",
        snippet: "review before durable memory writes",
        matchedFields: ["body"],
      },
    ]);
    expect(context.snippets[0]).toEqual(expect.objectContaining({ sourceType: "memory", provider: "test-memory" }));
  });

  it("loads profile and memory from the active profile folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-context-"));
    await mkdir(path.join(root, "02-Profiles/lin"), { recursive: true });
    await writeFile(path.join(root, "02-Profiles/lin/Profile.md"), "# Lin Profile\n\nProduct builder.", "utf8");
    await writeFile(path.join(root, "02-Profiles/lin/Memory.md"), "# Lin Memory\n\n- Prefers auditable memory.", "utf8");

    const context = await buildTurnContext({
      db: {} as AppDatabase,
      workspaceId: "workspace-1",
      workspaceRoot: root,
      activeProfileId: "lin",
      query: "what do you know about me?",
      recallProviders: [],
    });

    expect(context.profile).toContain("Product builder.");
    expect(context.memory).toContain("Prefers auditable memory.");
  });
});
