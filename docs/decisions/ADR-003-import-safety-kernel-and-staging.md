# ADR-003 - Import Safety Kernel and Staging

**Date:** 2026-07-29
**Status:** Proposed

## Context

Imported content is classified from multiple signals and may also be affected by
saved workspace routing rules or a user's choices during Review. Classification
and routing suggestions can improve organization, but they are not sufficient
authority for filesystem writes. Missing, conflicting, sensitive, or malformed
signals must fail safely, and pending content must not appear as accepted
knowledge before the user resolves Review.

The previous runtime behavior placed pending imported source notes in a user
knowledge folder. That made staged material visible to knowledge indexing and
blurred the distinction between a proposal and an accepted note.

## Decision

The import safety kernel in code is the mandatory safety floor for every import
write and promotion. It validates paths, classifications, evidence, confidence,
sensitivity, protected categories and destinations, collisions, and Review
approval proof. Policy configuration, model output, and agent skills may supply
or refine classification and routing intent, but they cannot weaken or bypass
the kernel.

Precedence for import routing is:

```text
current Review category and destination overrides
> validated saved workspace routing rule
> automatic classification and default routing
```

A saved routing rule may pre-populate a later Review item, but it never approves
the item or bypasses Review. The current user's Review choices take precedence
over both saved rules and automatic suggestions.

Pending imported source notes are written under:

```text
.app/import-staging/
```

This staging area is excluded from knowledge indexing and generated
`llms-flat.txt` content. Review approval promotes the same staged Markdown note
to its selected destination while preserving its attachment reference.
Destination collisions and other blocked safety decisions leave the source in
staging.

This rule replaces the previous runtime behavior that placed pending imported
source notes in a user knowledge folder.

Final import destinations must be normalized Markdown files under one of these
approved knowledge roots:

```text
00-Inbox/
01-Projects/
02-Personal/
03-Knowledge/
04-Resources/
07-Private/
08-Archive/
```

`.vault/decisions/` is also an approved final root, but remains Review-protected.
Internal runtime and source-preservation roots are distinct from final roots:
`.app/`, `.vault/memory/`, `05-Templates/`, and `06-Attachments/` can never be
final import destinations. Approval does not override an invalid final root.

Attachment copy, staging creation, and final promotion share a hardened
filesystem boundary that validates real paths and ancestors, rejects symlinks,
revalidates device and inode identity, and uses no-follow exclusive creation.
Auto-write promotion is source-bound and recorded in a durable journal under
`.app/`; recovery runs on workspace activation and before later imports. A
recovery accepts only the journaled source, staging path, final path, and
content hash, then deterministically leaves one authoritative final file.

Review promotion also binds recovery to its persisted application. If a prior
application selected destination A, retries must finish or reconcile A before a
new override B can be prepared. An exact approved hash completes A; a mismatch
fails closed.

## Consequences

- Unreviewed imports are physically and logically separate from accepted
  knowledge.
- Search and generated indexes do not expose staged notes.
- User Review choices have deterministic precedence without granting saved
  policy authority to skip Review.
- Classification, policy, model, and skill layers can evolve independently as
  long as they continue to satisfy the code-enforced safety floor.
- Import promotion must preserve the staged note and attachment relationship,
  and must fail closed on collisions, stale approval proof, invalid paths, or
  internal evaluation errors.
- Original source attachments are copied before extraction and remain available
  when extraction or a later source in the batch fails.
- Expired Review application and rejection leases become retryable without
  discarding persisted application intent.
- Concurrent durable routing-rule writes are serialized per workspace and
  replace policy and contract files atomically.
- Product audits and tests must cover every import writer and promotion path so
  new code cannot silently bypass safety evaluation.

## Alternatives considered

### Keep pending notes in a knowledge folder

This makes files easy to inspect, but causes proposals to appear as accepted
knowledge and allows indexing before Review. A dedicated non-indexed staging
area preserves inspectability without that ambiguity.

### Let saved policy auto-approve matching imports

This reduces Review work, but turns durable routing configuration into a safety
bypass. Saved rules therefore provide defaults only.

### Let model or skill instructions enforce safety

Natural-language instructions and probabilistic classification are useful
inputs, but they cannot reliably guard every filesystem writer. Safety-critical
validation remains deterministic code.

## Implementation notes

- `packages/workspace/src/importSafety.ts` implements the safety decision floor.
- `packages/workspace/src/importClassification.ts` combines classification
  signals conservatively.
- `packages/workspace/src/secureWorkspaceIo.ts` implements the shared hardened
  filesystem boundary.
- `packages/workspace/src/importPromotion.ts` implements source-bound promotion
  journaling and recovery.
- `packages/workspace/src/routingPolicy.ts` defines the staging route and default
  destinations.
- `packages/workspace/src/indexer.ts` excludes `.app/` content from knowledge
  indexing.
- `apps/desktop/electron/ipc.ts` re-evaluates safety and applies current Review
  overrides when promoting staged imports.
- `packages/workspace/src/productAudit.ts` checks writer coverage, staging
  contracts, precedence text, and Review bypass fields.
