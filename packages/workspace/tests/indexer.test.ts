import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, searchNotes, type AppDatabase } from "@kb-agent/storage";
import { indexWorkspace, parseMarkdownNote } from "../src/index";

let opened: AppDatabase[] = [];

afterEach(() => {
  for (const db of opened) {
    db.close();
  }
  opened = [];
});

describe("parseMarkdownNote", () => {
  it("validates required frontmatter fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-md-"));
    const notePath = path.join(root, "Note.md");
    await writeFile(
      notePath,
      `---
title: Graph Memory
type: knowledge
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: [graph, memory]
---

# Graph Memory

Graph memory architecture with [[Links]].
`,
    );

    await expect(parseMarkdownNote(notePath)).resolves.toEqual(
      expect.objectContaining({
        frontmatter: expect.objectContaining({ title: "Graph Memory" }),
        headings: ["Graph Memory"],
        links: ["Links"],
      }),
    );
  });

  it("reports missing title frontmatter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-md-"));
    const notePath = path.join(root, "Broken.md");
    await writeFile(
      notePath,
      `---
type: knowledge
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

Broken.
`,
    );

    await expect(parseMarkdownNote(notePath)).rejects.toThrow(
      "Invalid frontmatter field title",
    );
  });

  it("accepts profile notes created by the default workspace template", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-md-"));
    const notePath = path.join(root, "Profile.md");
    await writeFile(
      notePath,
      `---
title: Default Profile
type: profile
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

# Default Profile

Profile body.
`,
    );

    await expect(parseMarkdownNote(notePath)).resolves.toEqual(
      expect.objectContaining({
        frontmatter: expect.objectContaining({ type: "profile" }),
      }),
    );
  });
});

describe("indexWorkspace", () => {
  it("indexes markdown notes into notes, chunks, and FTS tables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-index-"));
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);

    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");
    await writeNote(path.join(root, "03-Knowledge/中文搜索.md"), "中文搜索", "中文 搜索 测试");

    const result = await indexWorkspace(root, db);

    expect(result.noteCount).toBe(2);
    expect(db.sqlite.prepare("SELECT COUNT(*) as count FROM notes").get()).toEqual({ count: 2 });
    expect(db.sqlite.prepare("SELECT COUNT(*) as count FROM chunks").get()).toEqual({ count: 2 });
    expect(db.sqlite.prepare("SELECT COUNT(*) as count FROM note_fts").get()).toEqual({ count: 2 });
    expect(db.sqlite.prepare("SELECT COUNT(*) as count FROM note_fts_trigram").get()).toEqual({ count: 2 });
    await expect(searchNotes(db, "memory", { workspaceId: result.workspaceId })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Graph Memory" })]),
    );
    await expect(searchNotes(db, "中文", { workspaceId: result.workspaceId })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "中文搜索" })]),
    );
  });

  it("keeps the previous index when a later parse fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-index-"));
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);

    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");
    const first = await indexWorkspace(root, db);

    await writeFile(
      path.join(root, "03-Knowledge/Broken.md"),
      `---
type: knowledge
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: []
---

Broken.
`,
    );

    await expect(indexWorkspace(root, db)).rejects.toThrow("Invalid frontmatter field title");
    expect(db.sqlite.prepare("SELECT COUNT(*) as count FROM notes").get()).toEqual({ count: 1 });
    await expect(searchNotes(db, "memory", { workspaceId: first.workspaceId })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Graph Memory" })]),
    );
  });

  it("ignores raw markdown files in attachments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-index-"));
    const db = openAppDatabase(path.join(root, ".app/index.sqlite"));
    opened.push(db);

    await mkdir(path.join(root, "03-Knowledge"), { recursive: true });
    await mkdir(path.join(root, "06-Attachments/Imports/resume"), { recursive: true });
    await writeNote(path.join(root, "03-Knowledge/Graph Memory.md"), "Graph Memory", "Graph memory architecture");
    await writeFile(path.join(root, "06-Attachments/Imports/resume/Resume.md"), "# Raw imported resume\n\nNo frontmatter here.", "utf8");

    const result = await indexWorkspace(root, db);

    expect(result.noteCount).toBe(1);
    expect(db.sqlite.prepare("SELECT path FROM notes").all()).toEqual([
      { path: "03-Knowledge/Graph Memory.md" },
    ]);
  });
});

async function writeNote(filePath: string, title: string, body: string): Promise<void> {
  await writeFile(
    filePath,
    `---
title: ${title}
type: knowledge
status: active
owner: default
scope: personal
sensitivity: normal
created: 2026-07-20
tags: [test]
---

# ${title}

${body}
`,
  );
}
