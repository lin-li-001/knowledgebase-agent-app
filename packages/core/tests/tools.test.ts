import { describe, expect, it } from "vitest";
import { createToolRegistry, mvpToolNames } from "../src/index";

describe("tool registry", () => {
  it("contains only MVP tools with schemas and risk categories", () => {
    const registry = createToolRegistry();

    expect([...registry.keys()]).toEqual([...mvpToolNames]);
    for (const tool of registry.values()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(tool.maxResultSize).toBeGreaterThan(0);
      expect(tool.riskCategory).toMatch(/read|low|medium|high|explicit/u);
    }
  });
});
