import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertInsideWorkspace, assertRealPathInsideWorkspace, createWorkspace } from "../src/index";

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe("createWorkspace", () => {
  it("creates the default markdown workspace tree", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-"));

    const workspace = await createWorkspace(rootPath);

    expect(workspace.rootPath).toBe(path.resolve(rootPath));
    expect(workspace.profileId).toBe("default");

    const expectedPaths = [
      "AGENTS.md",
      "00-Inbox",
      "00-Inbox/Imports",
      "01-Projects",
      "02-Profiles/default/Profile.md",
      "02-Profiles/default/Memory.md",
      "03-Knowledge",
      "04-Resources/Imports",
      "05-Templates",
      "06-Attachments/Imports",
      ".vault/decisions",
      ".vault/memory/default",
      ".vault/CHANGES.md",
      ".app/exports",
      ".app/settings.json",
    ];

    await Promise.all(
      expectedPaths.map(async (relativePath) => {
        await expect(exists(path.join(rootPath, relativePath))).resolves.toBe(true);
      }),
    );

    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "Markdown files are the source of truth",
    );
    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "Imported source Markdown notes go to `04-Resources/Imports/<batch-name>/<source-stem>.md`",
    );
    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "Each imported source note records `route_status` and `route_destination`",
    );
    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "Imported original files go to `06-Attachments/Imports/<batch-name>/`",
    );
    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "Import candidate routing precedence",
    );
    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "00-Inbox/Imports/",
    );
    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "Profile memory lives at `02-Profiles/<profile-id>/Memory.md`",
    );
    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "User-defined durable routing rules are recorded in `.vault/routing-policy.json`",
    );
    await expect(readFile(path.join(rootPath, ".app/settings.json"), "utf8")).resolves.toContain(
      '"activeProfileId": "default"',
    );
  });

  it("upgrades an existing workspace contract without removing existing content", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-"));
    await writeFile(path.join(rootPath, "AGENTS.md"), "# Workspace Contract\n\n## User Routing Rules\n\n- bills -> 02-Personal/default/Finance/Utilities/\n");

    await createWorkspace(rootPath);

    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "- bills -> 02-Personal/default/Finance/Utilities/",
    );
    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "Import candidate routing precedence:",
    );
  });

  it("upgrades a legacy routing section without duplicating its heading", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-"));
    await writeFile(
      path.join(rootPath, "AGENTS.md"),
      "# Workspace Contract\n\n## Routing Policy\n\n- Imported summary notes go to `04-Resources/Imports/<batch-name>.md`.\n",
    );

    await createWorkspace(rootPath);
    await createWorkspace(rootPath);

    const contract = await readFile(path.join(rootPath, "AGENTS.md"), "utf8");
    expect(contract.match(/^## Routing Policy$/gm)).toHaveLength(1);
    expect(contract).toContain("Import candidate routing precedence:");
  });

  it("adds source note routing state to an existing source-first workspace contract", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-"));
    await writeFile(
      path.join(rootPath, "AGENTS.md"),
      "# Workspace Contract\n\n- Imported source Markdown notes go to `04-Resources/Imports/<batch-name>/<source-stem>.md`.\n",
    );

    await createWorkspace(rootPath);

    await expect(readFile(path.join(rootPath, "AGENTS.md"), "utf8")).resolves.toContain(
      "Each imported source note records `route_status` and `route_destination`",
    );
  });
});

describe("assertInsideWorkspace", () => {
  it("returns a normalized path for targets inside the workspace", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-"));

    expect(assertInsideWorkspace(rootPath, "00-Inbox/Note.md")).toBe(
      path.join(path.resolve(rootPath), "00-Inbox/Note.md"),
    );
  });

  it("rejects targets outside the workspace", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-"));

    expect(() => assertInsideWorkspace(rootPath, "../outside.md")).toThrow("Path escapes workspace");
  });
});

describe("assertRealPathInsideWorkspace", () => {
  it("accepts a nonexistent target under a real workspace parent", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-"));
    await mkdir(path.join(rootPath, "00-Inbox"), { recursive: true });

    await expect(assertRealPathInsideWorkspace(rootPath, "00-Inbox/New.md")).resolves.toBe(
      path.join(rootPath, "00-Inbox/New.md"),
    );
  });

  it("rejects a nonexistent target under a symlinked parent outside the workspace", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-"));
    const outsidePath = await mkdtemp(path.join(tmpdir(), "kb-agent-outside-"));
    await symlink(outsidePath, path.join(rootPath, "escaped"), "dir");

    await expect(assertRealPathInsideWorkspace(rootPath, "escaped/New.md")).rejects.toThrow(
      "Path resolves outside workspace",
    );
  });
});
