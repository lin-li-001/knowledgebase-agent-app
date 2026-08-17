import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  contentCategoryConfigPath,
  defaultContentCategoryConfig,
  loadContentCategoryRegistry,
  renderContentCategoryContract,
  serializeContentCategoryConfig,
} from "./contentCategories";
import {
  changesTemplate,
  memoryTemplate,
  profileTemplate,
  settingsTemplate,
  workspaceContract,
  workspaceRoutingPolicyContract,
} from "./templates";
import { defaultRoutingPolicy } from "./routingPolicy";
import {
  secureAtomicReplaceWorkspaceFile,
  secureReadWorkspaceArtifact,
  secureWorkspacePathExists,
  type SecureWorkspaceIoHooks,
} from "./secureWorkspaceIo";
import { withWorkspaceWriteLock } from "./workspaceWriteLock";

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
      path.join(normalizedRoot, contentCategoryConfigPath),
      serializeContentCategoryConfig(defaultContentCategoryConfig()),
      { flag: "wx" },
    ).catch(ignoreExistingFile),
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

export interface WorkspaceContractSyncOptions {
  ioHooks?: SecureWorkspaceIoHooks;
}

export async function syncWorkspaceContract(
  rootPath: string,
  options: WorkspaceContractSyncOptions = {},
): Promise<void> {
  await withWorkspaceWriteLock(
    rootPath,
    async (canonicalRoot) =>
      syncWorkspaceContractLocked(canonicalRoot, options),
    options.ioHooks === undefined ? {} : { ioHooks: options.ioHooks },
  );
}

export async function syncWorkspaceContractLocked(
  canonicalRoot: string,
  options: WorkspaceContractSyncOptions = {},
): Promise<void> {
  const contractPath = path.join(canonicalRoot, "AGENTS.md");
  const snapshot = await secureWorkspacePathExists(
    canonicalRoot,
    contractPath,
  )
    ? await secureReadWorkspaceArtifact(
      canonicalRoot,
      contractPath,
      {
        operation: "workspace_contract_read",
        hooks: options.ioHooks,
      },
    )
    : undefined;
  const current = snapshot?.contents.toString("utf8")
    ?? "# Workspace Contract\n";
  const normalizedCurrent = current.replace(/\r\n?/gu, "\n");

  const sourceNoteRoute = ".app/import-staging/<import-id>/<source-stem>.md";
  const sourceNoteRouteLine = "- Imported source Markdown notes remain non-indexed under `.app/import-staging/<import-id>/<source-stem>.md` while pending Review; low-risk imports are immediately written to `00-Inbox/Imports/`.";
  const sourceNoteRouteStatusLine = "- Each imported source note records `route_status` and `route_destination`; a Review approval moves that same note to its final destination.";
  const routingPriorityBlock = `Import candidate routing precedence:
1. Current Review category and destination overrides take precedence over all saved rules and automatic routing.
2. Saved workspace routing rule in \`.vault/routing-policy.json\`.
3. Semantic import candidate policy for content type and risk.
4. \`defaultRoutingPolicy\` base path fallback.
5. \`00-Inbox/Imports/\` fallback when the app cannot classify the import.`;
  const safetyContractLines = [
    "- Pending import notes are non-indexed under `.app/import-staging/`.",
    "- The Safety Kernel must approve every final import write.",
    "1. Current Review category and destination overrides take precedence over all saved rules and automatic routing.",
    "Saved workspace routing rules never bypass Review.",
    "- The `## Document` body of an imported source note is source evidence. Agent proposals must not rewrite it.",
    "- Chat may propose Review-gated metadata changes or append a provenance-bearing `## Annotations` entry. Cross-document synthesis belongs in a separate note that cites its sources.",
    "- imported source annotations require Review; imported source-body replacement is not allowed",
  ];
  const obsoleteSourceNoteRouteLine = "- Imported source Markdown notes go to `04-Resources/Imports/<batch-name>/<source-stem>.md` while pending Review; low-risk imports are immediately written to `00-Inbox/Imports/`.";
  const hasSourceNoteRoute = normalizedCurrent.includes(sourceNoteRoute);
  const hasSourceNoteRouteStatus = normalizedCurrent.includes("route_status") && normalizedCurrent.includes("route_destination");

  const legacyRoute = "- Imported summary notes go to `04-Resources/Imports/<batch-name>.md`.";
  let next = normalizedCurrent
    .replace(obsoleteSourceNoteRouteLine, sourceNoteRouteLine)
    .replaceAll(
      ".app/import-staging/<batch-name>/",
      ".app/import-staging/<import-id>/",
    );
  if (!hasSourceNoteRoute && !next.includes(sourceNoteRoute)) {
    next = next.includes(legacyRoute)
      ? next.replace(legacyRoute, sourceNoteRouteLine)
      : `${next.trimEnd()}\n\n${sourceNoteRouteLine}\n`;
  }

  if (!hasSourceNoteRouteStatus) {
    next = `${next.trimEnd()}\n${sourceNoteRouteStatusLine}\n`;
  }

  if (!next.includes("Import candidate routing precedence:")) {
    const contractTail = workspaceRoutingPolicyContract
      .replace(`${sourceNoteRouteLine}\n`, "")
      .replace(`${sourceNoteRouteStatusLine}\n`, "");
    const routingPrecedence = contractTail.replace(/^## Routing Policy\n\n/, "");
    next = normalizedCurrent.includes("## Routing Policy")
      ? `${next.trimEnd()}\n\n${routingPrecedence}`
      : `${next.trimEnd()}\n\n${contractTail}`;
  }

  next = synchronizeRoutingPriorityBlock(next, routingPriorityBlock);

  const categoryContract = renderContentCategoryContract(
    await loadContentCategoryRegistry(canonicalRoot),
  );
  if (!next.includes("<!-- BEGIN MANAGED: content-categories -->")) {
    next = `${next.trimEnd()}\n\n${categoryContract}\n`;
  }

  for (const line of safetyContractLines) {
    if (!next.includes(line)) {
      next = `${next.trimEnd()}\n${line}\n`;
    }
  }

  if (next !== current) {
    await secureAtomicReplaceWorkspaceFile(
      canonicalRoot,
      contractPath,
      next,
      {
        operation: "workspace_contract_write",
        hooks: options.ioHooks,
        tempToken: "workspace-contract",
        ...(snapshot === undefined
          ? { requireAbsent: true }
          : { expectedArtifact: snapshot.artifact }),
      },
    );
  }
}

function synchronizeRoutingPriorityBlock(contract: string, routingPriorityBlock: string): string {
  const priorityBlockPattern = /(?:^|\n)Import candidate routing precedence:\n(?:\d+\.[^\n]*(?:\n|$))*/gmu;
  let inserted = false;
  const synchronized = contract.replace(priorityBlockPattern, () => {
    if (inserted) {
      return "\n";
    }
    inserted = true;
    return `\n${routingPriorityBlock}\n`;
  });

  return inserted ? synchronized : `${contract.trimEnd()}\n\n${routingPriorityBlock}\n`;
}

function ignoreExistingFile(error: unknown): void {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    return;
  }

  throw error;
}
