export type ProposalRisk = "low" | "medium" | "high" | "explicit";

export interface Proposal {
  proposalType: "create_note" | "update_note" | "memory" | "decision" | "delete" | "move" | "overwrite";
  noteType?: string;
  sensitivity?: "normal" | "private" | "sensitive";
  targetChanged?: boolean;
}

export function classifyProposalRisk(proposal: Proposal): ProposalRisk {
  if (proposal.targetChanged) {
    return "high";
  }

  if (proposal.proposalType === "delete" || proposal.proposalType === "move" || proposal.proposalType === "overwrite") {
    return "explicit";
  }

  if (proposal.proposalType === "memory" || proposal.proposalType === "decision") {
    return "high";
  }

  if (proposal.sensitivity === "private" || proposal.sensitivity === "sensitive") {
    return "high";
  }

  if (proposal.noteType === "profile") {
    return "high";
  }

  if (proposal.proposalType === "update_note") {
    return "medium";
  }

  return "low";
}
