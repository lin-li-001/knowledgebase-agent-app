import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { assertImportedSourceBodyPreserved, assertInsideWorkspace } from "@kb-agent/workspace";

export type ReviewState =
  | "proposed"
  | "approved"
  | "applying"
  | "applied"
  | "rejecting"
  | "rejected"
  | "superseded"
  | "failed";

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
  "proposed->applying",
  "proposed->rejecting",
  "proposed->rejected",
  "proposed->superseded",
  "approved->applied",
  "approved->failed",
  "approved->applying",
  "applying->applied",
  "applying->failed",
  "rejecting->rejected",
  "rejecting->failed",
  "failed->proposed",
  "failed->applying",
  "failed->rejecting",
]);

export function transitionReviewState(from: ReviewState, to: ReviewState): ReviewState {
  if (!validTransitions.has(`${from}->${to}`)) {
    throw new Error("Invalid review transition");
  }

  return to;
}

export async function applyReviewItem(item: ReviewItem, workspaceRoot: string): Promise<ReviewItem> {
  if (!item.targetPath || !item.patch) {
    return { ...item, state: transitionReviewState(item.state, "failed"), failureReason: "Missing target or patch" };
  }

  const targetPath = assertInsideWorkspace(workspaceRoot, item.targetPath);
  const currentBody = await readFile(targetPath, "utf8");
  const currentHash = createHash("sha256").update(currentBody).digest("hex");
  if (currentHash !== item.patch.baseContentHash) {
    return {
      ...item,
      state: transitionReviewState(item.state, "failed"),
      failureReason: "Target changed since proposal",
    };
  }

  if (item.patch.kind === "replace_body") {
    assertImportedSourceBodyPreserved(currentBody, item.patch.nextBody);
    await writeFile(targetPath, item.patch.nextBody, "utf8");
    return { ...item, state: transitionReviewState(item.state, "applied") };
  }

  const nextBody = replaceSection(currentBody, item.patch.headingPath, item.patch.nextSectionBody);
  assertImportedSourceBodyPreserved(currentBody, nextBody);
  await writeFile(targetPath, nextBody, "utf8");
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
