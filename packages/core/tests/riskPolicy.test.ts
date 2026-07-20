import { describe, expect, it } from "vitest";
import { classifyProposalRisk } from "../src/index";

describe("risk policy", () => {
  it("classifies low-risk new notes", () => {
    expect(classifyProposalRisk({ proposalType: "create_note", noteType: "resource", sensitivity: "normal" })).toBe("low");
    expect(classifyProposalRisk({ proposalType: "create_note", noteType: "inbox", sensitivity: "normal" })).toBe("low");
  });

  it("classifies formal and sensitive writes as high risk", () => {
    expect(classifyProposalRisk({ proposalType: "create_note", noteType: "profile", sensitivity: "normal" })).toBe("high");
    expect(classifyProposalRisk({ proposalType: "create_note", noteType: "resource", sensitivity: "private" })).toBe("high");
    expect(classifyProposalRisk({ proposalType: "memory", sensitivity: "normal" })).toBe("high");
  });

  it("classifies updates and stale updates", () => {
    expect(classifyProposalRisk({ proposalType: "update_note", sensitivity: "normal" })).toBe("medium");
    expect(classifyProposalRisk({ proposalType: "update_note", targetChanged: true })).toBe("high");
  });

  it("requires explicit confirmation for destructive operations", () => {
    expect(classifyProposalRisk({ proposalType: "delete" })).toBe("explicit");
    expect(classifyProposalRisk({ proposalType: "overwrite" })).toBe("explicit");
    expect(classifyProposalRisk({ proposalType: "move" })).toBe("explicit");
  });
});
