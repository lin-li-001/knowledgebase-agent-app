# ADR-002 - User-Defined Routing Rules

**Date:** 2026-07-26
**Status:** Proposed

## Context

Imported files should not all become resource notes. A personal knowledge-base
agent needs to route different content types differently: bills, resumes,
family records, project plans, durable memories, decisions, and learning
resources do not belong in the same folder.

The product also needs to let users correct routing during Review. A user may
make a one-time destination choice or teach the workspace a durable rule for
similar future imports.

## Decision

Review approvals may include a user-provided destination override for knowledge
write proposals.

If the user marks the override as a durable routing rule, the app records it in
three places:

- `.vault/routing-policy.json` as machine-readable workspace policy.
- `AGENTS.md` as the human-readable workspace contract.
- `.vault/decisions/routing-rule-<review-id>.md` as an ADR-style audit record.

The precedence model is:

```text
current Review destination override
> validated workspace routing-policy.json
> defaultRoutingPolicy.ts
> AGENTS.md explanation
```

`AGENTS.md` is not parsed as runtime source of truth. It explains policy for
humans and agents, while validated policy/config and code drive writes.

## Consequences

- Users can teach the agent how to organize their workspace without editing code.
- Durable routing changes are auditable and traceable back to the Review item.
- One-time routing choices do not pollute long-term workspace policy.
- The app must maintain drift checks between machine-readable policy,
  human-readable contract, and decision records.

## Alternatives considered

### Always use the model's suggested route

This is convenient but too opaque. The model may misclassify sensitive or
personal documents, and the user would have no durable way to correct future
behavior.

### Let AGENTS.md drive routing directly

This is readable but unstable for filesystem writes because it requires parsing
natural-language instructions at runtime.

### Only support one-off destination overrides

This avoids policy management, but users would need to repeat the same routing
corrections for every similar import.

## Implementation notes

- Review cards expose a destination field for create-note and decision proposals.
- Review approval accepts `targetPathOverride`, `saveAsRoutingRule`, and
  `routingRulePattern`.
- Durable user rules are appended to `.vault/routing-policy.json`.
- `AGENTS.md` receives a `User Routing Rules` section when a durable rule is saved.
- A routing-rule ADR is written under `.vault/decisions/`.

