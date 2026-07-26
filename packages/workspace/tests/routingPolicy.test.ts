import { describe, expect, it } from "vitest";
import { defaultRoutingPolicy } from "../src/index";

describe("defaultRoutingPolicy", () => {
  it("exposes base routing folders used when creating a workspace", () => {
    expect(defaultRoutingPolicy.importSummaryDir()).toBe("04-Resources/Imports");
    expect(defaultRoutingPolicy.importAttachmentRoot()).toBe("06-Attachments/Imports");
    expect(defaultRoutingPolicy.exportDir()).toBe(".app/exports");
  });

  it("routes imported originals and summaries to the documented workspace folders", () => {
    expect(defaultRoutingPolicy.importAttachmentDir("2026 Utility Bills")).toBe(
      "06-Attachments/Imports/2026 Utility Bills",
    );
    expect(defaultRoutingPolicy.importSummaryNotePath("2026 Utility Bills")).toBe(
      "04-Resources/Imports/2026 Utility Bills.md",
    );
  });

  it("routes profile files to the active profile folder", () => {
    expect(defaultRoutingPolicy.profilePath("default")).toBe("02-Profiles/default/Profile.md");
    expect(defaultRoutingPolicy.profileMemoryPath("default")).toBe("02-Profiles/default/Memory.md");
  });

  it("routes workspace decision records to the governance folder", () => {
    expect(defaultRoutingPolicy.decisionPath("review-123")).toBe(".vault/decisions/review-123.md");
  });
});
