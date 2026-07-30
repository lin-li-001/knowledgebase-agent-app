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
.app/import-staging/<import-id>/<source-stem>.md
```

This staging area is excluded from knowledge indexing and generated
`llms-flat.txt` content. Review approval promotes the same staged Markdown note
to its selected destination while preserving its attachment reference.
Destination collisions and other blocked safety decisions leave the source in
staging.

Original attachments retain the user-visible batch grouping at
`06-Attachments/Imports/<batch-name>/`, and unclassified inbox fallback notes
use `00-Inbox/Imports/<batch-name>.md`. `<import-id>` is reserved for the
transaction-scoped staging directory.

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
Extraction consumes bytes read back through a verified attachment file handle;
extractors do not reopen the attachment pathname.

Auto-write promotion is source-bound and recorded in a durable journal under
`.app/`. A journal records the attachment path, hash, and identity; the staging
path, hash, device, and inode; the expected final body hash; and the final
device and inode after publication. Journal creation and phase updates write a
unique exclusive temp file in the journal directory whose name includes the
transaction ID, complete and `fsync` that file, rename it atomically, and
`fsync` the directory. Recovery does not remove a fresh or active transaction
temp. It cleans a temp explicitly referenced by its owned journal, or
identity-quarantines an unreferenced temp only after a conservative stale
grace. A malformed final journal is quarantined without preventing other valid
journals from being processed.

An authoritative final path is never written incrementally. Promotion writes
and verifies a temp file in the canonical destination parent, `fsync`s it,
publishes it only if the final path is absent by hard-linking the temp inode,
and `fsync`s the destination parent. The temp and every later cleanup target
are removed only when their recorded path, parent, device, inode, size, and hash
still match. Between hard-link publication and recording the final pathname,
the recorded final-temp inode is also ownership proof for the final pathname;
verification, reconciliation, and rollback retarget that exact identity rather
than treating the pathname as unowned. Staging retirement and rollback first
rename the verified artifact to a unique quarantine name in the same verified
parent, revalidate the moved identity, and only then unlink it. If a staging or
final path has been replaced, the newer artifact is preserved and recovery
fails closed.

Recovery runs on workspace activation and before later imports. Immediately
before retiring staging, it reopens the exact recorded staging and attachment
artifacts, verifies their hashes and identities, and verifies that the staged
attachment binding still names that attachment. A collision or identity
mismatch is not accepted as an old final.

Review promotion also binds recovery to its persisted application. If a prior
application selected destination A and routing options A, every retry ignores
conflicting request options and replays the persisted destination, category,
saved-rule choice, and rule pattern for apply, saved-rule output, and activity.
Incoming options create only the first application intent. The UI initializes
its controls from that intent and labels the action Resume. Persisted intent
also removes Reject and clear-intent authority, and the storage claim for
rejection fails closed. If final A was published but staging retirement or
later work failed, a retry verifies and completes A rather than writing
override B. A mismatch fails closed.

Durable routing-rule updates canonicalize the workspace with `realpath` and
hold a workspace-local `.app/routing-policy.lock` across policy, `AGENTS.md`,
and decision-record updates. Workspace activation takes the same canonical lock
while synchronizing the generated contract. A locked internal sync variant
avoids recursively acquiring the lock during saved-rule updates.

Lock metadata is first written completely to a token-named exclusive temp,
`fsync`ed, and exclusively hard-linked to the absent authoritative lock path.
It contains a random token, PID, creation timestamp, heartbeat timestamp, and
lease expiry. While held, identity- and token-checked atomic heartbeat
replacements renew the lease. Contenders do not steal a lock merely because a
wall-clock lease elapsed while its PID is live; stale or malformed
authoritative locks are identity-quarantined only after the corresponding
conservative checks. Release verifies both the latest identity and token.

Policy and `AGENTS.md` are each replaced by an `fsync`ed temp plus atomic rename
and parent-directory `fsync`. They are not one cross-file transaction, so a
process stop between the two files can temporarily leave contract drift; the
next locked update reconciles all saved rules and Product Audit reports
remaining drift.

### Local threat boundary

Node exposes `O_NOFOLLOW`, but it does not expose the directory-handle-relative
`openat`/`renameat`/`unlinkat` operations needed to eliminate every pathname
race. These controls are designed for a local, single-user workspace with
cooperating app processes. They detect symlinks, inode changes, parent swaps,
and the tested crash windows, and they prefer leaving or quarantining an
artifact when ownership cannot be proved. They do not claim protection from a
malicious process with the same filesystem permissions that wins the remaining
interval between a final identity check and a pathname operation.

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
- Original source attachments are copied and read back through a verified
  no-follow handle before extraction.
- Batch rollback, final rollback, and staging retirement remove only artifacts
  whose recorded identities still match; replacement content survives.
- Expired Review application leases become retryable without discarding
  persisted application intent; an item with application intent cannot be
  claimed for rejection.
- Concurrent durable routing-rule writes and activation contract sync are
  serialized across app processes; policy and contract files are each replaced
  atomically.
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
  filesystem boundary, atomic publishers, and identity-bound quarantine.
- `packages/workspace/src/importPromotion.ts` implements source-bound promotion
  journaling and recovery.
- `packages/workspace/src/workspaceWriteLock.ts` implements the leased
  cross-process routing lock.
- `packages/workspace/src/routingPolicy.ts` defines the staging route and default
  destinations.
- `packages/workspace/src/indexer.ts` excludes `.app/` content from knowledge
  indexing.
- `apps/desktop/electron/ipc.ts` re-evaluates safety and applies current Review
  overrides when promoting staged imports.
- `packages/workspace/src/productAudit.ts` checks secure extraction data flow,
  identity-bound cleanup, atomic journal/final publication, cross-process
  locking, staging contracts, precedence text, and Review bypass fields.
