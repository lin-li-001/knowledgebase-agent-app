import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  changesTemplate,
  memoryTemplate,
  profileTemplate,
  settingsTemplate,
  workspaceContract,
} from "./templates";

export interface WorkspaceInfo {
  rootPath: string;
  profileId: string;
  settingsPath: string;
}

const directories = [
  "00-Inbox",
  "01-Projects",
  "02-Profiles/default",
  "03-Knowledge",
  "04-Resources/Imports",
  "05-Templates",
  "06-Attachments/Imports",
  ".vault/decisions",
  ".vault/memory/default",
  ".vault/memory/shared",
  ".app/exports",
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
    writeFile(path.join(normalizedRoot, "02-Profiles/default/Profile.md"), profileTemplate, {
      flag: "wx",
    }).catch(ignoreExistingFile),
    writeFile(path.join(normalizedRoot, "02-Profiles/default/Memory.md"), memoryTemplate, {
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

  return {
    rootPath: normalizedRoot,
    profileId: "default",
    settingsPath: path.join(normalizedRoot, ".app/settings.json"),
  };
}

function ignoreExistingFile(error: unknown): void {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    return;
  }

  throw error;
}
