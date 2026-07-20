import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import { parseFrontmatter, type NoteFrontmatter } from "./frontmatter";

export interface ParsedMarkdownNote {
  path: string;
  frontmatter: NoteFrontmatter;
  headings: string[];
  body: string;
  links: string[];
  contentHash: string;
}

export async function parseMarkdownNote(filePath: string): Promise<ParsedMarkdownNote> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const frontmatter = parseFrontmatter(parsed.data);
  const body = parsed.content.trim();

  return {
    path: filePath,
    frontmatter,
    headings: extractHeadings(body),
    body,
    links: extractWikilinks(body),
    contentHash: createHash("sha256").update(raw).digest("hex"),
  };
}

function extractHeadings(body: string): string[] {
  return body
    .split(/\r?\n/u)
    .map((line) => line.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim())
    .filter((heading): heading is string => Boolean(heading));
}

function extractWikilinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]]+)\]\]/gu)].map((match) => match[1] ?? "");
}
