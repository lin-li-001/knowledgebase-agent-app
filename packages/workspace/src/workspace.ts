import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  changesTemplate,
  memoryTemplate,
  profileTemplate,
  settingsTemplate,
  workspaceContract,
  workspaceRoutingPolicyContract,
} from "./templates";
import { defaultRoutingPolicy } from "./routingPolicy";

export interface WorkspaceInfo {
  rootPath: string;
  profileId: string;
  settingsPath: string;
}

const directories = [
  "00-Inbox",
  defaultRoutingPolicy.importInboxDir(),
  "01-Projects",
  path.dirname(defaultRoutingPolicy.profileMemoryPath("default")),
  "03-Knowledge",
  defaultRoutingPolicy.importSummaryDir(),
  "05-Templates",
  defaultRoutingPolicy.importAttachmentRoot(),
  path.dirname(defaultRoutingPolicy.decisionPath("default")),
  ".vault/memory/default",
  defaultRoutingPolicy.exportDir(),
];

export async function createWorkspace(rootPath: string): Promise<WorkspaceInfo> {
  const normalizedRoot = path.resolve(rootPath);

  await mkdir(normalizedRoot, { recursive: true });
  await Promise.all(
    directories.map(async (directory) => {
      await mkdir(path.join(normalizedRoot, directory), { recursive: true });
    }),
  );

  await Promise.all([
    writeFile(path.join(normalizedRoot, "AGENTS.md"), workspaceContract, { flag: "wx" }).catch(
      ignoreExistingFile,
    ),
    writeFile(path.join(normalizedRoot, defaultRoutingPolicy.profilePath("default")), profileTemplate, {
      flag: "wx",
    }).catch(ignoreExistingFile),
    writeFile(path.join(normalizedRoot, defaultRoutingPolicy.profileMemoryPath("default")), memoryTemplate, {
      flag: "wx",
    }).catch(ignoreExistingFile),
    writeFile(path.join(normalizedRoot, ".vault/CHANGES.md"), changesTemplate, {
      flag: "wx",
    }).catch(ignoreExistingFile),
    writeFile(
      path.join(normalizedRoot, ".app/settings.json"),
      `${JSON.stringify(settingsTemplate, null, 2)}\n`,
      { flag: "wx" },
    ).catch(ignoreExistingFile),
  ]);

  await syncWorkspaceContract(normalizedRoot);

  return {
    rootPath: normalizedRoot,
    profileId: "default",
    settingsPath: path.join(normalizedRoot, ".app/settings.json"),
  };
}

export async function syncWorkspaceContract(rootPath: string): Promise<void> {
  const contractPath = path.join(path.resolve(rootPath), "AGENTS.md");
  const current = await readFile(contractPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "# Workspace Contract\n";
    }
    throw error;
  });

  const sourceNoteRoute = "04-Resources/Imports/<batch-name>/<source-stem>.md";
  const sourceNoteRouteLine = "- Imported source Markdown notes go to `04-Resources/Imports/<batch-name>/<source-stem>.md` while pending Review; low-risk imports are immediately written to `00-Inbox/Imports/`.";
  const sourceNoteRouteStatusLine = "- Each imported source note records `route_status` and `route_destination`; a Review approval moves that same note to its final destination.";
  const currentReviewOverrideLine = "1. Current Review category and destination overrides take precedence over all saved rules and automatic routing.";
  const legacyReviewTargetOverrideLine = "1. Review target override from the current approval.";
  const safetyContractLines = [
    "- Pending import notes are non-indexed under `.app/import-staging/`.",
    "- The Safety Kernel must approve every final import write.",
    currentReviewOverrideLine,
    "Saved workspace routing rules never bypass Review.",
  ];
  const hasSourceNoteRoute = current.includes(sourceNoteRoute);
  const hasSourceNoteRouteStatus = current.includes("route_status") && current.includes("route_destination");
  const hasRoutingPrecedence = current.includes("Import candidate routing precedence:");
  const hasSafetyContract = safetyContractLines.every((line) => current.includes(line));
  if (hasSourceNoteRoute && hasSourceNoteRouteStatus && hasRoutingPrecedence && hasSafetyContract) {
    return;
  }

  const legacyRoute = "- Imported summary notes go to `04-Resources/Imports/<batch-name>.md`.";
  let next = hasSourceNoteRoute
    ? current
    : current.includes(legacyRoute)
      ? current.replace(legacyRoute, sourceNoteRouteLine)
      : `${current.trimEnd()}\n\n${sourceNoteRouteLine}\n`;

  if (!hasSourceNoteRouteStatus) {
    next = `${next.trimEnd()}\n${sourceNoteRouteStatusLine}\n`;
  }

  if (!hasRoutingPrecedence) {
    const contractTail = workspaceRoutingPolicyContract
      .replace(`${sourceNoteRouteLine}\n`, "")
      .replace(`${sourceNoteRouteStatusLine}\n`, "");
    const routingPrecedence = contractTail.replace(/^## Routing Policy\n\n/, "");
    next = current.includes("## Routing Policy")
      ? `${next.trimEnd()}\n\n${routingPrecedence}`
      : `${next.trimEnd()}\n\n${contractTail}`;
  }

  if (next.includes(legacyReviewTargetOverrideLine) && !next.includes(currentReviewOverrideLine)) {
    next = next.replace(legacyReviewTargetOverrideLine, currentReviewOverrideLine);
  }

  for (const line of safetyContractLines) {
    if (!next.includes(line)) {
      next = `${next.trimEnd()}\n${line}\n`;
    }
  }

  await writeFile(contractPath, next, "utf8");
}

function ignoreExistingFile(error: unknown): void {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    return;
  }

  throw error;
}
