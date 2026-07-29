import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateImportSafety,
  fingerprintImportClassification,
  type ContentCategory,
  type ImportClassification,
  type ImportApprovalProof,
  type ImportWriteIntent,
} from "../src/index";

const workspaceRoot = "/tmp/import-safety-workspace";

function classification(
  overrides: Partial<ImportClassification> = {},
): ImportClassification {
  return {
    primaryCategory: "resource",
    alternativeCategories: [],
    sensitivity: "normal",
    confidence: 1,
    evidence: ["source evidence"],
    signals: [],
    conflict: false,
    ...overrides,
  };
}

function validIntent(overrides: Partial<ImportWriteIntent> = {}): ImportWriteIntent {
  return {
    workspaceRoot,
    operation: "create",
    destination: "04-Resources/Imports/A.md",
    destinationExists: false,
    autoWriteThreshold: 0.9,
    classification: classification(),
    ...overrides,
  };
}

function approvalFor(
  value: ImportClassification,
  overrides: Partial<ImportApprovalProof> = {},
): ImportApprovalProof {
  const destination = overrides.destination ?? "04-Resources/Imports/A.md";
  return {
    reviewItemId: "review-123",
    destination: path.resolve(workspaceRoot, destination),
    classificationFingerprint: fingerprintImportClassification(value),
    ...overrides,
  };
}

describe("evaluateImportSafety", () => {
  it.each([
    ["workspace escape", { operation: "create", destination: "../outside.md" }, "PATH_ESCAPES_WORKSPACE"],
    ["overwrite", { operation: "overwrite", destination: "00-Inbox/A.md" }, "OPERATION_NOT_ALLOWED"],
    ["delete", { operation: "delete", destination: "00-Inbox/A.md" }, "OPERATION_NOT_ALLOWED"],
    ["collision", { operation: "move", destination: "00-Inbox/A.md", destinationExists: true }, "DESTINATION_EXISTS"],
    ["malformed destination", { operation: "create", destination: "" }, "PATH_ESCAPES_WORKSPACE"],
    ["unsupported operation", { operation: "publish" }, "OPERATION_NOT_ALLOWED"],
  ])("blocks %s", (_name, partial, reasonCode) => {
    const result = evaluateImportSafety(validIntent(partial as Partial<ImportWriteIntent>));

    expect(result.decision).toBe("blocked");
    expect(result.reasonCodes).toContain(reasonCode);
  });

  it("blocks a destination containing a NUL byte", () => {
    const result = evaluateImportSafety(validIntent({ destination: "04-Resources/\0A.md" }));

    expect(result).toMatchObject({
      decision: "blocked",
      reasonCodes: ["PATH_ESCAPES_WORKSPACE"],
    });
  });

  it("requires Review when classification is missing", () => {
    const result = evaluateImportSafety(validIntent({ classification: undefined }));

    expect(result).toMatchObject({
      decision: "review_required",
      reasonCodes: ["CLASSIFICATION_MISSING"],
    });
  });

  it.each([
    ["unknown category", classification({ primaryCategory: "unknown" }), "CLASSIFICATION_UNKNOWN"],
    ["classifier conflict", classification({ conflict: true }), "CLASSIFIER_CONFLICT"],
    ["low confidence", classification({ confidence: 0.89 }), "CONFIDENCE_BELOW_THRESHOLD"],
  ])("requires Review for %s", (_name, value, reasonCode) => {
    const result = evaluateImportSafety(validIntent({ classification: value }));

    expect(result.decision).toBe("review_required");
    expect(result.reasonCodes).toContain(reasonCode);
  });

  it.each([
    ["personal", "personal"],
    ["private", "private"],
    ["restricted", "restricted"],
  ])("requires Review for %s sensitivity", (_name, sensitivity) => {
    const result = evaluateImportSafety(
      validIntent({ classification: classification({ sensitivity }) }),
    );

    expect(result.decision).toBe("review_required");
    expect(result.reasonCodes).toContain("SENSITIVITY_REQUIRES_REVIEW");
  });

  it.each([
    "finance.utility",
    "finance.insurance",
    "finance.tax",
    "finance.statement",
    "profile.career",
    "profile.personal_fact",
    "memory.candidate",
    "decision.record",
  ])("requires Review for protected category %s", (primaryCategory) => {
    const result = evaluateImportSafety(
      validIntent({
        classification: classification({
          primaryCategory: primaryCategory as ContentCategory,
        }),
      }),
    );

    expect(result.decision).toBe("review_required");
    expect(result.reasonCodes).toContain("CATEGORY_REQUIRES_REVIEW");
  });

  it("requires Review for protected destinations", () => {
    for (const destination of [
      "02-Personal/default/Finance/Tax.md",
      "02-Profiles/default/Profile.md",
      "07-Private/Secret.md",
      ".vault/decisions/review.md",
    ]) {
      const result = evaluateImportSafety(validIntent({ destination }));

      expect(result.decision).toBe("review_required");
      expect(result.reasonCodes).toContain("DESTINATION_REQUIRES_REVIEW");
    }
  });

  it("accumulates category and sensitivity Review reasons", () => {
    const result = evaluateImportSafety(
      validIntent({
        classification: classification({
          primaryCategory: "finance.tax",
          sensitivity: "personal",
        }),
      }),
    );

    expect(result).toMatchObject({
      decision: "review_required",
      reasonCodes: expect.arrayContaining([
        "CATEGORY_REQUIRES_REVIEW",
        "SENSITIVITY_REQUIRES_REVIEW",
      ]),
    });
  });

  it.each(["detector", "model", "saved_user_policy", "current_user_override"] as const)(
    "requires Review for protected evidence from %s",
    (source) => {
      const destination = "04-Resources/Imports/User Choice.md";
      const result = evaluateImportSafety(
        validIntent({
          destination,
          classification: classification({
            signals: [
              {
                source,
                category: "finance.utility",
                evidence: ["protected signal"],
                destination: "02-Personal/default/Finance/Unexpected.md",
              },
            ],
          }),
        }),
      );

      expect(result).toMatchObject({
        decision: "review_required",
        allowedDestination: path.resolve(workspaceRoot, destination),
      });
      expect(result.reasonCodes).toContain("SAFETY_SIGNAL_REQUIRES_REVIEW");
    },
  );

  it.each(["detector", "model", "saved_user_policy", "current_user_override"] as const)(
    "requires Review for unknown evidence from %s",
    (source) => {
      const result = evaluateImportSafety(
        validIntent({
          classification: classification({
            signals: [{ source, category: "unknown", evidence: ["unknown signal"] }],
          }),
        }),
      );

      expect(result.decision).toBe("review_required");
      expect(result.reasonCodes).toContain("SAFETY_SIGNAL_REQUIRES_REVIEW");
    },
  );

  it.each(["detector", "model", "saved_user_policy", "current_user_override"] as const)(
    "requires Review for below-threshold evidence from %s",
    (source) => {
      const result = evaluateImportSafety(
        validIntent({
          classification: classification({
            signals: [{ source, category: "resource", confidence: 0.5, evidence: ["low signal"] }],
          }),
        }),
      );

      expect(result.decision).toBe("review_required");
      expect(result.reasonCodes).toContain("SAFETY_SIGNAL_REQUIRES_REVIEW");
    },
  );

  it.each(["detector", "model", "saved_user_policy", "current_user_override"] as const)(
    "requires Review for sensitive evidence from %s",
    (source) => {
      const result = evaluateImportSafety(
        validIntent({
          classification: classification({
            signals: [{ source, category: "resource", sensitivity: "private", evidence: ["private signal"] }],
          }),
        }),
      );

      expect(result.decision).toBe("review_required");
      expect(result.reasonCodes).toContain("SAFETY_SIGNAL_REQUIRES_REVIEW");
    },
  );

  it("fingerprints equivalent classification values deterministically", () => {
    const value = classification({
      signals: [{ source: "model", category: "resource", evidence: ["same value"] }],
    });

    expect(fingerprintImportClassification(value)).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintImportClassification({ ...value })).toBe(fingerprintImportClassification(value));
    expect(fingerprintImportClassification({ ...value, confidence: 0.99 })).not.toBe(
      fingerprintImportClassification(value),
    );
  });

  it("auto-writes a safe resource create", () => {
    expect(
      evaluateImportSafety(
        validIntent({
          classification: classification({
            primaryCategory: "resource",
            sensitivity: "normal",
            confidence: 0.95,
          }),
        }),
      ),
    ).toMatchObject({
      decision: "auto_write",
      reasonCodes: [],
    });
  });

  it("requires Review when the active threshold is stricter", () => {
    const result = evaluateImportSafety(
      validIntent({
        autoWriteThreshold: 0.96,
        classification: classification({ confidence: 0.95 }),
      }),
    );

    expect(result).toMatchObject({
      decision: "review_required",
      reasonCodes: ["CONFIDENCE_BELOW_THRESHOLD"],
    });
  });

  it.each(["create", "stage"] as const)("does not let a proof authorize %s", (operation) => {
    const value = classification({
      primaryCategory: "finance.tax",
      sensitivity: "personal",
      confidence: 0.5,
    });
    const result = evaluateImportSafety(
      validIntent({
        operation,
        classification: value,
        approval: approvalFor(value),
      }),
    );

    expect(result).toMatchObject({
      decision: "review_required",
      reasonCodes: expect.arrayContaining([
        "CATEGORY_REQUIRES_REVIEW",
        "SENSITIVITY_REQUIRES_REVIEW",
      ]),
    });
  });

  it.each([
    ["missing proof", undefined],
    ["empty review id", { reviewItemId: " " }],
    ["destination mismatch", { destination: "04-Resources/Imports/Other.md" }],
    ["classification mismatch", { classificationFingerprint: "not-the-current-fingerprint" }],
  ])("does not clear Review reasons for %s", (_name, proofOverrides) => {
    const value = classification({
      primaryCategory: "finance.tax",
      sensitivity: "personal",
      confidence: 0.5,
    });
    const proof = proofOverrides === undefined ? undefined : approvalFor(value, proofOverrides);
    const result = evaluateImportSafety(
      validIntent({
        operation: "move",
        classification: value,
        approval: proof,
      }),
    );

    expect(result).toMatchObject({
      decision: "review_required",
      reasonCodes: expect.arrayContaining([
        "CATEGORY_REQUIRES_REVIEW",
        "SENSITIVITY_REQUIRES_REVIEW",
      ]),
    });
  });

  it("lets a valid proof clear Review-only reasons for one move", () => {
    const value = classification({
      primaryCategory: "finance.tax",
      sensitivity: "personal",
      confidence: 0.5,
    });
    const destination = "02-Personal/default/Finance/Tax.md";
    const result = evaluateImportSafety(
      validIntent({
        operation: "move",
        destination,
        classification: value,
        approval: approvalFor(value, { destination }),
      }),
    );

    expect(result).toMatchObject({
      decision: "auto_write",
      reasonCodes: [],
    });
  });

  it("requires Review for case variants of protected destinations", () => {
    for (const destination of [
      "02-personal/default/Finance/Tax.md",
      "02-PROFILES/default/Profile.md",
      "07-private/Secret.md",
      ".VAULT/DECISIONS/review.md",
    ]) {
      const result = evaluateImportSafety(validIntent({ destination }));

      expect(result.decision).toBe("review_required");
      expect(result.reasonCodes).toContain("DESTINATION_REQUIRES_REVIEW");
    }
  });

  it("does not let an approval proof clear blocked reasons", () => {
    const value = classification({
      primaryCategory: "finance.tax",
      sensitivity: "personal",
    });
    const result = evaluateImportSafety(
      validIntent({
        operation: "move",
        destination: "../outside.md",
        classification: value,
        approval: approvalFor(value, { destination: "../outside.md" }),
      }),
    );

    expect(result.decision).toBe("blocked");
    expect(result.reasonCodes).toContain("PATH_ESCAPES_WORKSPACE");
  });
});
