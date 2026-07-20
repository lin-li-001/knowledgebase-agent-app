import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export type ReviewState = "proposed" | "approved" | "applied" | "rejected" | "superseded" | "failed";

export type ProposalPatch =
  | {
      kind: "replace_body";
      baseContentHash: string;
      nextBody: string;
    }
  | {
      kind: "replace_section";
      baseContentHash: string;
      headingPath: string[];
      nextSectionBody: string;
    };

export interface ReviewItem {
  id: string;
  state: ReviewState;
  targetPath?: string;
  patch?: ProposalPatch;
  failureReason?: string;
}

const validTransitions = new Set([
  "proposed->approved",
  "proposed->rejected",
  "proposed->superseded",
  "approved->applied",
  "approved->failed",
  "failed->proposed",
]);

export function transitionReviewState(from: ReviewState, to: ReviewState): ReviewState {
  if (!validTransitions.has(`${from}->${to}`)) {
    throw new Error("Invalid review transition");
  }

  return to;
}

export async function applyReviewItem(item: ReviewItem): Promise<ReviewItem> {
  if (!item.targetPath || !item.patch) {
    return { ...item, state: transitionReviewState(item.state, "failed"), failureReason: "Missing target or patch" };
  }

  const currentBody = await readFile(item.targetPath, "utf8");
  const currentHash = createHash("sha256").update(currentBody).digest("hex");
  if (currentHash !== item.patch.baseContentHash) {
    return {
      ...item,
      state: transitionReviewState(item.state, "failed"),
      failureReason: "Target changed since proposal",
    };
  }

  if (item.patch.kind === "replace_body") {
    await writeFile(item.targetPath, item.patch.nextBody, "utf8");
    return { ...item, state: transitionReviewState(item.state, "applied") };
  }

  const nextBody = replaceSection(currentBody, item.patch.headingPath, item.patch.nextSectionBody);
  await writeFile(item.targetPath, nextBody, "utf8");
  return { ...item, state: transitionReviewState(item.state, "applied") };
}

function replaceSection(body: string, headingPath: string[], nextSectionBody: string): string {
  const heading = headingPath.at(-1);
  if (!heading) {
    return nextSectionBody;
  }

  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^#{1,6}\\s+${escapedHeading}\\s*$)[\\s\\S]*?(?=^#{1,6}\\s+|\\z)`, "mu");
  if (!pattern.test(body)) {
    return `${body.trim()}\n\n# ${heading}\n\n${nextSectionBody}\n`;
  }

  return body.replace(pattern, `$1\n\n${nextSectionBody}\n\n`);
}
