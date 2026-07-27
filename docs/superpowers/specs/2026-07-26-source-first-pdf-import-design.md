# Source-First PDF Import Design

## Decision

Each imported source file has exactly one durable Markdown representation. The original file remains unchanged in `06-Attachments/Imports/<batch>/`. The Markdown note begins in `04-Resources/Imports/<batch>/` and moves as one unit to its final routed destination when the route is decided.

## Document Shape

For an imported PDF, the product creates:

```text
06-Attachments/Imports/<batch>/<source>.pdf
04-Resources/Imports/<batch>/<source>.md
```

The Markdown note contains:

1. Required frontmatter, including `summary`, source attachment link, import metadata, route status, and destination when known.
2. A short derived summary, stored in frontmatter and rendered once near the top of the note.
3. The complete best-effort Markdown conversion of the PDF body.
4. A source section linking to the unchanged PDF.
5. A routing section with status and final/suggested destination.

The app must not create a second Markdown digest that repeats source text. For multi-file batches, an optional manifest may list the imported notes and their states, but must not copy their bodies.

## Routing Lifecycle

1. The note is created under `04-Resources/Imports/<batch>/` with route status `pending_review` or `inbox`.
2. A low-risk unclassified note is immediately written to `00-Inbox/Imports/` and its routing metadata is updated to `inbox`.
3. A high-risk candidate remains at its import path with `pending_review`; Review owns the decision.
4. On approval, the app moves the same Markdown note to the approved destination, preserving body, frontmatter, and attachment link. It updates route metadata to `approved`.
5. The original attachment never moves as part of routing.

## PDF Conversion

The first implementation targets text-layer PDFs. It must preserve extracted text in reading order and retain headings, paragraphs, lists, page boundaries, and embedded-image references where the converter can determine them. The conversion is explicitly best-effort: unsupported layout details are not invented.

Scanned or image-only PDFs are reported as requiring OCR. OCR is outside this implementation.

## Summary

The summary is derived from the complete converted Markdown, not copied from the first paragraph. It must be substantially shorter than the source body and must not duplicate the full body under another heading.

## Failure Handling

- If source extraction fails, do not create a Markdown note; retain the original attachment only when copying has succeeded and report the extraction error.
- If a route move fails, retain the existing imported note and its route status; do not create a duplicate at the destination.
- Existing imports using the legacy single batch summary are not rewritten automatically. New imports use the source-first model.

## Verification

- One PDF produces one attachment and one Markdown note containing body, source link, route metadata, and derived summary.
- Low-risk imports create their Inbox note immediately.
- High-risk imports create one pending Review item and do not create a destination duplicate before approval.
- Approval moves the original Markdown note to the selected destination and preserves its content.
- Multi-file imports create one Markdown note per source and no duplicated source body in a batch manifest.
