import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendImportedSourceAnnotation,
  assertImportedSourceBodyPreserved,
  importedSourceBodyHash,
  sourceBodyEndMarker,
  sourceBodyStartMarker,
} from "../src/index";

const documentBody = "<!-- Page 1 -->\n\nOriginal resume evidence.";

function importedNote(body = documentBody, bodyHash = importedSourceBodyHash(body)): string {
  return `---
title: Resume
type: resource
status: approved
owner: default
scope: personal
sensitivity: personal
created: 2026-08-16
tags: [imported]
source_type: import
source_file: ../06-Attachments/Imports/Resume/Resume.pdf
source_sha256: ${createHash("sha256").update("pdf bytes").digest("hex")}
source_body_sha256: ${bodyHash}
source_integrity: source_evidence
extraction_version: 1
---

# Resume

## Document

${sourceBodyStartMarker}
${body}
${sourceBodyEndMarker}

## Source

- Original PDF
`;
}

describe("imported source evidence", () => {
  it("appends a provenance-bearing annotation without changing the source body", () => {
    const current = importedNote();
    const next = appendImportedSourceAnnotation(current, {
      body: "User confirmed this project was completed at Example Corp.",
      date: "2026-08-16",
      reviewItemId: "review-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(next).toContain("## Annotations");
    expect(next).toContain("User confirmed this project was completed at Example Corp.");
    expect(next).toContain("session `session-1`");
    expect(next).toContain("review `review-1`");
    expect(next).toContain(`${sourceBodyStartMarker}\n${documentBody}\n${sourceBodyEndMarker}`);
    expect(importedSourceBodyHash(documentBody)).toBe(
      createHash("sha256").update(documentBody).digest("hex"),
    );
  });

  it("rejects an annotation when the extracted source body changed", () => {
    const changed = importedNote("Changed source body.", importedSourceBodyHash(documentBody));

    expect(() => appendImportedSourceAnnotation(changed, {
      body: "An annotation that must not be applied.",
      date: "2026-08-16",
      reviewItemId: "review-1",
      sessionId: "session-1",
      turnId: "turn-1",
    })).toThrow("Imported source body integrity check failed");
  });

  it("rejects ordinary notes and annotation bodies containing source markers", () => {
    const ordinary = importedNote().replace("source_type: import", "source_type: chat");
    expect(() => appendImportedSourceAnnotation(ordinary, {
      body: "Not allowed.",
      date: "2026-08-16",
      reviewItemId: "review-1",
      sessionId: "session-1",
      turnId: "turn-1",
    })).toThrow("Target is not verified imported source evidence");

    expect(() => appendImportedSourceAnnotation(importedNote(), {
      body: sourceBodyStartMarker,
      date: "2026-08-16",
      reviewItemId: "review-1",
      sessionId: "session-1",
      turnId: "turn-1",
    })).toThrow("Annotation contains a reserved source marker");
  });

  it("allows metadata enrichment but preserves source identity metadata", () => {
    const current = importedNote();
    expect(() => assertImportedSourceBodyPreserved(
      current,
      current.replace("tags: [imported]", "tags: [imported, resume]"),
    )).not.toThrow();
    expect(() => assertImportedSourceBodyPreserved(
      current,
      current.replace("source_integrity: source_evidence", "source_integrity: user_modified"),
    )).toThrow("Imported source identity metadata cannot be modified");
  });
});
