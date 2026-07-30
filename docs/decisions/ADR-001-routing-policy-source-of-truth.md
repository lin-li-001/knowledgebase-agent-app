# ADR-001 - Routing Policy Source of Truth

**Date:** 2026-07-26
**Status:** Proposed

## Context

The product has two places that describe where knowledge artifacts should go:

- `AGENTS.md`, the human-readable workspace contract that explains rules to users and agents.
- `routingPolicy.ts`, the executable code that chooses filesystem paths for writes.

For example, pending imported source notes go to
`.app/import-staging/<import-id>/<source-stem>.md`, while original imported
files go to `06-Attachments/Imports/<batch-name>/`. Unclassified inbox
fallback notes use `00-Inbox/Imports/<batch-name>.md`; an import ID identifies
the staging transaction and does not replace the user-visible batch name.

This creates an intentional mirror: users need to inspect the rule in plain
language, while the app needs deterministic code to enforce the rule. If the two
drift, the product could become confusing or unsafe.

## Decision

`routingPolicy.ts` is the execution source of truth for filesystem routing.

`AGENTS.md` is the human-readable contract that explains the same policy for
users and agents, but it does not directly drive writes at runtime.

If `routingPolicy.ts` and `AGENTS.md` conflict:

- Runtime behavior follows `routingPolicy.ts`.
- Product audit checks and tests must detect the mismatch.
- The conflict must be resolved by updating the code policy, the contract text, or both.
- Material routing changes should be recorded in an ADR or implementation plan.

Package/public-ready product ADRs live in this repository under:

```text
docs/decisions/
```

ADR copies in this repository must omit private planning paths, private user
context, and sensitive knowledge-base references while preserving the product
decision and rationale.

## Consequences

- Filesystem writes are deterministic and testable.
- Users can inspect routing behavior in `AGENTS.md` without reading code.
- Conflict handling is explicit: code wins at runtime, product audit catches drift, and decisions are traceable.
- The same rule is expressed in executable code and human-readable prose, so tests must guard against drift.
- The app repo becomes a complete audit artifact for package/public review.

## Alternatives considered

### AGENTS.md as the only source of truth

This would make the workspace contract fully user-editable, but would require
runtime parsing or model interpretation of natural-language rules. That is too
unstable for filesystem writes and path safety.

### routingPolicy.ts only

This would make runtime behavior deterministic, but users would not be able to
inspect where knowledge goes without reading source code. That conflicts with
the product goal of traceable, auditable personal knowledge.

### Configurable routing policy now

A future version could load a validated config file such as
`.vault/routing-policy.json`. That should get its own ADR because it changes
precedence and user customization rules.

## Implementation notes

- `packages/workspace/src/routingPolicy.ts` defines the default executable routing policy.
- `packages/workspace/src/imports.ts` uses the policy for staging, attachment,
  inbox fallback, and final paths.
- `packages/workspace/src/workspace.ts` uses the policy when creating default workspace folders and profile memory.
- `packages/workspace/src/templates.ts` includes the human-readable routing rules in generated `AGENTS.md`.
- `packages/workspace/src/productAudit.ts` checks routing/contract drift, filesystem writer bypasses, and the presence of this decision mirror.
- `pnpm audit:product` runs product audit checks.
