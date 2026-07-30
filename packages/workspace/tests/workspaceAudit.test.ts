import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "@kb-agent/storage";
import {
  auditWorkspace,
  createWorkspace,
  defaultRoutingPolicy,
  indexWorkspace,
} from "../src/index";

let opened: AppDatabase[] = [];

afterEach(() => {
  for (const db of opened) {
    db.close();
  }
  opened = [];
});

describe("auditWorkspace", () => {
  it("reports workspace governance issues without modifying files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-audit-"));
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);

    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await mkdir(path.join(root, defaultRoutingPolicy.importAttachmentDir("resume")), { recursive: true });
    await writeFile(path.join(root, defaultRoutingPolicy.importAttachmentDir("resume"), "resume.pdf"), "source", "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nOutdated contract.", "utf8");
    await writeFile(path.join(root, "03-Knowledge/Broken.md"), "# Broken\n\nMissing frontmatter.", "utf8");
    const utilitySourcePath = "00-Inbox/Imports/utility bills/utility.md";
    await mkdir(path.dirname(path.join(root, utilitySourcePath)), { recursive: true });
    await mkdir(path.join(root, defaultRoutingPolicy.importAttachmentDir("utility bills")), { recursive: true });
    await writeFile(path.join(root, defaultRoutingPolicy.importAttachmentDir("utility bills"), "utility.txt"), "source", "utf8");
    await writeImportedSourceNote(
      path.join(root, utilitySourcePath),
      "utility bills",
      "../../../06-Attachments/Imports/utility bills/utility.txt",
    );

    const result = await auditWorkspace({ rootPath: root, db });

    expect(result.status).toBe("fail");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_frontmatter", path: "03-Knowledge/Broken.md" }),
        expect.objectContaining({ code: "attachment_without_source_note", path: "06-Attachments/Imports/resume/resume.pdf" }),
        expect.objectContaining({ code: "import_source_note_not_indexed", path: utilitySourcePath }),
        expect.objectContaining({ code: "agents_drift", path: "AGENTS.md" }),
        expect.objectContaining({ code: "routing_drift", path: "AGENTS.md" }),
      ]),
    );
  });

  it("passes indexed source notes after the workspace index is fresh", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-audit-"));
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);

    const resumeSourcePath = "00-Inbox/Imports/resume/resume.md";
    await mkdir(path.dirname(path.join(root, resumeSourcePath)), { recursive: true });
    await writeFile(
      path.join(root, "AGENTS.md"),
      [
        "# Workspace Contract",
        "",
        `Imported source Markdown notes remain non-indexed under \`${defaultRoutingPolicy.importStagingRoot()}/<import-id>/<source-stem>.md\`.`,
        `Imported original files go to \`${defaultRoutingPolicy.importAttachmentRoot()}/<import-id>/\`.`,
        "Profile memory lives at `02-Profiles/<profile-id>/Memory.md`.",
        "Workspace decision records live at `.vault/decisions/<decision-id>.md`.",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(root, defaultRoutingPolicy.importAttachmentDir("resume")), { recursive: true });
    await writeFile(path.join(root, defaultRoutingPolicy.importAttachmentDir("resume"), "resume.txt"), "source", "utf8");
    await writeImportedSourceNote(
      path.join(root, resumeSourcePath),
      "resume",
      "../../../06-Attachments/Imports/resume/resume.txt",
    );
    await indexWorkspace(root, db);

    const result = await auditWorkspace({ rootPath: root, db });

    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "import_source_note_not_indexed" }),
      ]),
    );
  });

  it("reports stale note index entries when files change after indexing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-audit-"));
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);

    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeFile(
      path.join(root, "AGENTS.md"),
      [
        "# Workspace Contract",
        "",
        `Imported source Markdown notes remain non-indexed under \`${defaultRoutingPolicy.importStagingRoot()}/<import-id>/<source-stem>.md\`.`,
        `Imported original files go to \`${defaultRoutingPolicy.importAttachmentRoot()}/<import-id>/\`.`,
        "Profile memory lives at `02-Profiles/<profile-id>/Memory.md`.",
        "Workspace decision records live at `.vault/decisions/<decision-id>.md`.",
      ].join("\n"),
      "utf8",
    );
    await writeNote(path.join(root, "03-Knowledge/Freshness.md"), "Freshness", "Original body.");
    await indexWorkspace(root, db);
    await writeNote(path.join(root, "03-Knowledge/Freshness.md"), "Freshness", "Changed body.");

    const result = await auditWorkspace({ rootPath: root, db });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "note_index_stale", path: "03-Knowledge/Freshness.md" }),
      ]),
    );
  });

  it("uses staged source notes for attachment binding without auditing them as indexed notes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-audit-"));
    await createWorkspace(root);
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);
    const attachmentPath = path.join(
      root,
      defaultRoutingPolicy.importAttachmentDir("import-1"),
      "Utility.pdf",
    );
    const stagingPath = path.join(
      root,
      defaultRoutingPolicy.importStagingNotePath("import-1", "Utility"),
    );
    await mkdir(path.dirname(attachmentPath), { recursive: true });
    await mkdir(path.dirname(stagingPath), { recursive: true });
    await writeFile(attachmentPath, "source", "utf8");
    await writeImportedSourceNote(
      stagingPath,
      "Utility",
      "../06-Attachments/Imports/import-1/Utility.pdf",
      "03-Knowledge/Utility.md",
    );
    await indexWorkspace(root, db);

    const result = await auditWorkspace({ rootPath: root, db });

    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: defaultRoutingPolicy.importStagingNotePath("import-1", "Utility"),
      }),
    ]));
    expect(result.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "attachment_without_source_note" }),
    ]));
  });

  it("accepts a generated AGENTS contract and flags a retained legacy pending route", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-audit-"));
    await createWorkspace(root);

    const clean = await auditWorkspace({ rootPath: root });
    expect(clean.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "agents_drift" }),
      expect.objectContaining({ code: "routing_drift" }),
    ]));

    const agentsPath = path.join(root, "AGENTS.md");
    const agents = await readFile(agentsPath, "utf8");
    await writeFile(
      agentsPath,
      `${agents}\n- Imported source Markdown notes go to \`04-Resources/Imports/<import-id>/<source-stem>.md\` while pending Review.\n`,
      "utf8",
    );

    const drifted = await auditWorkspace({ rootPath: root });
    expect(drifted.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "agents_drift",
        message: expect.stringContaining("obsolete"),
      }),
    ]));
  });
});

async function writeNote(filePath: string, title: string, body: string): Promise<void> {
  await writeFile(
    filePath,
    `---
title: ${title}
type: resource
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-26
tags: []
---

# ${title}

${body}
`,
    "utf8",
  );
}

async function writeImportedSourceNote(
  filePath: string,
  title: string,
  sourceFile: string,
  routeDestination = `02-Personal/default/Finance/Utilities/2026/${title}.md`,
): Promise<void> {
  await writeFile(
    filePath,
    `---
title: ${title}
type: resource
status: pending_review
owner: default
scope: personal
sensitivity: normal
created: 2026-07-26
tags: [imported, pending-review]
source_type: import
source_file: ${sourceFile}
summary: Imported source.
route_status: pending_review
route_destination: ${routeDestination}
---

# ${title}
`,
    "utf8",
  );
}
