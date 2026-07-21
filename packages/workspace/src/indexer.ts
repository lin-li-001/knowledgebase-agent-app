import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AppDatabase } from "@kb-agent/storage";
import { parseMarkdownNote, type ParsedMarkdownNote } from "./markdown";

export interface IndexWorkspaceResult {
  workspaceId: string;
  noteCount: number;
}

export async function indexWorkspace(rootPath: string, db: AppDatabase): Promise<IndexWorkspaceResult> {
  const normalizedRoot = path.resolve(rootPath);
  const workspaceId = workspaceIdForRoot(normalizedRoot);
  const now = new Date().toISOString();

  db.sqlite
    .prepare(
      `INSERT INTO workspaces (id, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at`,
    )
    .run(workspaceId, normalizedRoot, now, now);

  const markdownPaths = await collectMarkdownFiles(normalizedRoot);
  const parsedNotes: ParsedMarkdownNote[] = [];
  for (const filePath of markdownPaths) {
    parsedNotes.push(await parseMarkdownNote(filePath));
  }

  db.sqlite.transaction(() => {
    clearWorkspaceIndex(db, workspaceId);
    for (const parsed of parsedNotes) {
      insertParsedNote(db, workspaceId, normalizedRoot, parsed, now);
    }
  })();

  return {
    workspaceId,
    noteCount: markdownPaths.length,
  };
}

function clearWorkspaceIndex(db: AppDatabase, workspaceId: string): void {
  const noteIds = db.sqlite
    .prepare("SELECT id FROM notes WHERE workspace_id = ?")
    .all(workspaceId)
    .map((row) => (row as { id: string }).id);

  for (const noteId of noteIds) {
    db.sqlite.prepare("DELETE FROM note_fts WHERE note_id = ?").run(noteId);
    db.sqlite.prepare("DELETE FROM note_fts_trigram WHERE note_id = ?").run(noteId);
  }

  db.sqlite.prepare("DELETE FROM notes WHERE workspace_id = ?").run(workspaceId);
}

async function collectMarkdownFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }

      files.push(...(await collectMarkdownFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md") {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function shouldSkipDirectory(name: string): boolean {
  return name === ".app" || name === "node_modules" || name.startsWith(".");
}

function insertParsedNote(
  db: AppDatabase,
  workspaceId: string,
  rootPath: string,
  note: ParsedMarkdownNote,
  now: string,
): void {
  const relativePath = path.relative(rootPath, note.path);
  const summary = note.frontmatter.summary ?? firstMeaningfulParagraph(note.body);
  const noteId = createHash("sha256").update(`${workspaceId}:${relativePath}`).digest("hex");

  db.sqlite
    .prepare(
      `INSERT INTO notes (
        id, workspace_id, path, title, type, status, owner, scope, sensitivity,
        tags_json, summary, summary_source, content_hash, modified_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      noteId,
      workspaceId,
      relativePath,
      note.frontmatter.title,
      note.frontmatter.type,
      note.frontmatter.status,
      note.frontmatter.owner,
      note.frontmatter.scope,
      note.frontmatter.sensitivity,
      JSON.stringify(note.frontmatter.tags),
      summary,
      note.frontmatter.summary ? "frontmatter" : "heuristic",
      note.contentHash,
      now,
      now,
    );

  const headings = note.headings.join("\n");
  db.sqlite
    .prepare("INSERT INTO note_fts (note_id, workspace_id, title, summary, headings, body, path) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(noteId, workspaceId, note.frontmatter.title, summary, headings, note.body, relativePath);
  db.sqlite
    .prepare("INSERT INTO note_fts_trigram (note_id, workspace_id, title, summary, headings, body, path) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(noteId, workspaceId, note.frontmatter.title, summary, headings, note.body, relativePath);

  insertChunks(db, noteId, relativePath, note);
}

function insertChunks(db: AppDatabase, noteId: string, relativePath: string, note: ParsedMarkdownNote): void {
  const text = note.body;
  db.sqlite
    .prepare(
      `INSERT INTO chunks (
        id, note_id, path, heading_path, text, start_line, end_line, token_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${noteId}:0`,
      noteId,
      relativePath,
      JSON.stringify(note.headings.slice(0, 1)),
      text,
      1,
      text.split(/\r?\n/u).length,
      text.split(/\s+/u).filter(Boolean).length,
    );
}

function firstMeaningfulParagraph(body: string): string {
  return (
    body
      .split(/\n\s*\n/u)
      .map((paragraph) => paragraph.replace(/^#{1,6}\s+/u, "").trim())
      .find(Boolean) ?? ""
  );
}

export function workspaceIdForRoot(rootPath: string): string {
  return createHash("sha256").update(path.resolve(rootPath)).digest("hex");
}
