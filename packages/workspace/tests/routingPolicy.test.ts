import { describe, expect, it } from "vitest";
import { defaultRoutingPolicy } from "../src/index";

describe("defaultRoutingPolicy", () => {
  it("exposes base routing folders used when creating a workspace", () => {
    expect(defaultRoutingPolicy.importSummaryDir()).toBe("04-Resources/Imports");
    expect(defaultRoutingPolicy.importAttachmentRoot()).toBe("06-Attachments/Imports");
    expect(defaultRoutingPolicy.exportDir()).toBe(".app/exports");
  });

  it("routes imported originals and source notes to the documented workspace folders", () => {
    expect(defaultRoutingPolicy.importAttachmentDir("2026 Utility Bills")).toBe(
      "06-Attachments/Imports/2026 Utility Bills",
    );
    expect(defaultRoutingPolicy.importInboxDir()).toBe("00-Inbox/Imports");
    expect(defaultRoutingPolicy.importInboxNotePath("2026 Utility Bills")).toBe(
      "00-Inbox/Imports/2026 Utility Bills.md",
    );
    expect(defaultRoutingPolicy.importInboxSourceNotePath("2026 Utility Bills", "2026-01 Electric")).toBe(
      "00-Inbox/Imports/2026 Utility Bills/2026-01 Electric.md",
    );
    expect(defaultRoutingPolicy.importSummaryNotePath("2026 Utility Bills")).toBe(
      "04-Resources/Imports/2026 Utility Bills.md",
    );
    expect(defaultRoutingPolicy.importSourceNotePath("2026 Utility Bills", "2026-01 Electric")).toBe(
      "04-Resources/Imports/2026 Utility Bills/2026-01 Electric.md",
    );
    expect(defaultRoutingPolicy.importStagingNotePath("job-1", "Handbook")).toBe(
      ".app/import-staging/job-1/Handbook.md",
    );
  });

  it("routes profile files to the active profile folder", () => {
    expect(defaultRoutingPolicy.profilePath("default")).toBe("02-Profiles/default/Profile.md");
    expect(defaultRoutingPolicy.profileMemoryPath("default")).toBe("02-Profiles/default/Memory.md");
    expect(defaultRoutingPolicy.profileFinanceDir("default")).toBe("02-Personal/default/Finance");
  });

  it("routes workspace decision records to the governance folder", () => {
    expect(defaultRoutingPolicy.decisionPath("review-123")).toBe(".vault/decisions/review-123.md");
  });
});
