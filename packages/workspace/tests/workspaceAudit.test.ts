import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "@kb-agent/storage";
import { auditWorkspace, defaultRoutingPolicy, indexWorkspace } from "../src/index";

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
    await mkdir(path.join(root, defaultRoutingPolicy.importSummaryDir()), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Workspace Contract\n\nOutdated contract.", "utf8");
    await writeFile(path.join(root, "03-Knowledge/Broken.md"), "# Broken\n\nMissing frontmatter.", "utf8");
    await mkdir(path.join(root, defaultRoutingPolicy.importSummaryDir(), "utility bills"), { recursive: true });
    await mkdir(path.join(root, defaultRoutingPolicy.importAttachmentDir("utility bills")), { recursive: true });
    await writeFile(path.join(root, defaultRoutingPolicy.importAttachmentDir("utility bills"), "utility.txt"), "source", "utf8");
    await writeImportedSourceNote(
      path.join(root, defaultRoutingPolicy.importSourceNotePath("utility bills", "utility")),
      "utility bills",
      "../../../06-Attachments/Imports/utility bills/utility.txt",
    );

    const result = await auditWorkspace({ rootPath: root, db });

    expect(result.status).toBe("fail");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_frontmatter", path: "03-Knowledge/Broken.md" }),
        expect.objectContaining({ code: "attachment_without_source_note", path: "06-Attachments/Imports/resume/resume.pdf" }),
        expect.objectContaining({ code: "import_source_note_not_indexed", path: defaultRoutingPolicy.importSourceNotePath("utility bills", "utility") }),
        expect.objectContaining({ code: "agents_drift", path: "AGENTS.md" }),
        expect.objectContaining({ code: "routing_drift", path: "AGENTS.md" }),
      ]),
    );
  });

  it("passes indexed source notes after the workspace index is fresh", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-workspace-audit-"));
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);

    await mkdir(path.join(root, defaultRoutingPolicy.importSummaryDir()), { recursive: true });
    await writeFile(
      path.join(root, "AGENTS.md"),
      [
        "# Workspace Contract",
        "",
        `Imported source Markdown notes go to \`${defaultRoutingPolicy.importSummaryDir()}/<batch-name>/<source-stem>.md\`.`,
        `Imported original files go to \`${defaultRoutingPolicy.importAttachmentRoot()}/<batch-name>/\`.`,
        "Profile memory lives at `02-Profiles/<profile-id>/Memory.md`.",
        "Workspace decision records live at `.vault/decisions/<decision-id>.md`.",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(root, defaultRoutingPolicy.importSummaryDir(), "resume"), { recursive: true });
    await mkdir(path.join(root, defaultRoutingPolicy.importAttachmentDir("resume")), { recursive: true });
    await writeFile(path.join(root, defaultRoutingPolicy.importAttachmentDir("resume"), "resume.txt"), "source", "utf8");
    await writeImportedSourceNote(
      path.join(root, defaultRoutingPolicy.importSourceNotePath("resume", "resume")),
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
        `Imported source Markdown notes go to \`${defaultRoutingPolicy.importSummaryDir()}/<batch-name>/<source-stem>.md\`.`,
        `Imported original files go to \`${defaultRoutingPolicy.importAttachmentRoot()}/<batch-name>/\`.`,
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

async function writeImportedSourceNote(filePath: string, title: string, sourceFile: string): Promise<void> {
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
route_destination: 02-Personal/default/Finance/Utilities/2026/${title}.md
---

# ${title}
`,
    "utf8",
  );
}
