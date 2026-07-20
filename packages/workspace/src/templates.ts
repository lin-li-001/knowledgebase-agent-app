export const workspaceContract = `# Workspace Contract

Markdown files are the source of truth. SQLite files under \`.app/\` are derived runtime state.

Read tools may inspect notes and indexed sessions. Write tools must follow the risk policy:
- low-risk new notes may auto-save and record activity
- profile, memory, sensitive, private, formal-note updates require Review
- delete, overwrite, move, and external account changes require explicit confirmation
`;

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
