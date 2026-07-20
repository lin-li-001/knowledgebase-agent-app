import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppDatabase } from "@kb-agent/storage";
import { workspaceIdForRoot } from "./indexer";

export async function exportLlmsFlat(rootPath: string, db: AppDatabase): Promise<string> {
  const normalizedRoot = path.resolve(rootPath);
  const workspaceId = workspaceIdForRoot(normalizedRoot);
  const exportPath = path.join(normalizedRoot, ".app/exports/llms-flat.txt");

  const rows = db.sqlite
    .prepare(
      `SELECT title, path, summary, status, tags_json
      FROM notes
      WHERE workspace_id = ?
      ORDER BY path ASC`,
    )
    .all(workspaceId) as Array<{
    title: string;
    path: string;
    summary: string | null;
    status: string;
    tags_json: string;
  }>;

  const content = rows
    .map((row) => {
      const tags = JSON.parse(row.tags_json) as string[];
      return [
        `title: ${row.title}`,
        `path: ${row.path}`,
        `summary: ${row.summary ?? ""}`,
        `status: ${row.status}`,
        `tags: ${tags.join(", ")}`,
      ].join("\n");
    })
    .join("\n\n");

  await mkdir(path.dirname(exportPath), { recursive: true });
  await writeFile(exportPath, `${content}\n`, "utf8");
  return exportPath;
}
