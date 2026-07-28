import { defaultRoutingPolicy } from "./routingPolicy";

export const importCandidateRoutingPrecedence = [
  "review_target_override",
  "saved_workspace_routing_rule",
  "semantic_import_candidate_policy",
  "default_routing_policy",
  "inbox_import_fallback",
] as const;

export type ImportCandidateRoutingPrecedence = typeof importCandidateRoutingPrecedence[number];

export interface ImportCandidateRouteInput {
  batchName: string;
  profileId?: string;
  year?: number;
}

export const importCandidateRoutingPolicy = {
  precedence: importCandidateRoutingPrecedence,
  financeUtilitiesDestination(input: ImportCandidateRouteInput): string {
    return `${defaultRoutingPolicy.profileFinanceDir(input.profileId ?? "default")}/Utilities/${input.year ?? new Date().getFullYear()}/${input.batchName}.md`;
  },
  profileMemoryDestination(profileId = "default"): string {
    return defaultRoutingPolicy.profileMemoryPath(profileId);
  },
  inboxFallbackDestination(input: ImportCandidateRouteInput): string {
    return defaultRoutingPolicy.importInboxNotePath(input.batchName);
  },
};
