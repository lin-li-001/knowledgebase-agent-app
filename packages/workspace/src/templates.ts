export const workspaceRoutingPolicyContract = `## Routing Policy

The app uses a code-enforced routing policy for filesystem writes. This contract explains the default paths so users can inspect and audit where knowledge goes.

- Imported source Markdown notes remain non-indexed under \`.app/import-staging/<import-id>/<source-stem>.md\` while pending Review; low-risk imports are immediately written to \`00-Inbox/Imports/\`.
- Each imported source note records \`route_status\` and \`route_destination\`; a Review approval moves that same note to its final destination.
- Pending import notes are non-indexed under \`.app/import-staging/\`.
- The Safety Kernel must approve every final import write.
- Imported original files go to \`06-Attachments/Imports/<import-id>/\`.
- Unclassified import candidates fall back to \`00-Inbox/Imports/<import-id>.md\` for user organization.
- Profile memory lives at \`02-Profiles/<profile-id>/Memory.md\`.
- Profile finance records live under \`02-Personal/<profile-id>/Finance/\`.
- Workspace decision records live at \`.vault/decisions/<decision-id>.md\`.
- Runtime exports live under \`.app/exports/\` and are derived, not source-of-truth notes.
- User-defined durable routing rules are recorded in \`.vault/routing-policy.json\`, summarized here for humans, and backed by ADR records.

Import candidate routing precedence:
1. Current Review category and destination overrides take precedence over all saved rules and automatic routing.
2. Saved workspace routing rule in \`.vault/routing-policy.json\`.
3. Semantic import candidate policy for content type and risk.
4. \`defaultRoutingPolicy\` base path fallback.
5. \`00-Inbox/Imports/\` fallback when the app cannot classify the import.

Saved workspace routing rules never bypass Review.

Read tools may inspect notes and indexed sessions. Write tools must follow the risk policy:
- low-risk new notes may auto-save and record activity
- profile, memory, sensitive, private, formal-note updates require Review
- delete, overwrite, move, and external account changes require explicit confirmation
`;

export const workspaceContract = `# Workspace Contract

Markdown files are the source of truth. SQLite files under \`.app/\` are derived runtime state.

${workspaceRoutingPolicyContract}`;

export const profileTemplate = `---
title: Default Profile
type: profile
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

# Default Profile

Use this profile to describe the person using this workspace.
`;

export const memoryTemplate = `---
title: Default Memory
type: memory
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

# Default Memory

Durable preferences and stable facts can be proposed here through Review.
`;

export const changesTemplate = `# Changes

This changelog records meaningful workspace changes.
`;

export const settingsTemplate = {
  activeProfileId: "default",
  autoSaveFeedback: "activity-feed",
  modelProvider: "mock",
};
