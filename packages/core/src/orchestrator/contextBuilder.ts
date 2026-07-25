import { readFile } from "node:fs/promises";
import path from "node:path";
import { searchNotes, type AppDatabase } from "@kb-agent/storage";
import type { RetrievedSnippet } from "./requestMessages";

export interface TurnContext {
  workspaceRules: string;
  profile: string;
  memory: string;
  snippets: RetrievedSnippet[];
}

export async function buildTurnContext(input: {
  db: AppDatabase;
  workspaceId: string;
  workspaceRoot: string;
  query: string;
}): Promise<TurnContext> {
  const [workspaceRules, profile, memory, candidates] = await Promise.all([
    readOptional(path.join(input.workspaceRoot, "AGENTS.md")),
    readOptional(path.join(input.workspaceRoot, "02-Profiles/default/Profile.md")),
    readOptional(path.join(input.workspaceRoot, "02-Profiles/default/Memory.md")),
    searchNotes(input.db, input.query, { workspaceId: input.workspaceId, limit: 5 }),
  ]);

  return {
    workspaceRules,
    profile,
    memory,
    snippets: candidates.map((candidate) => {
      const snippet: RetrievedSnippet = {
        title: candidate.title,
        path: candidate.path,
        text: candidate.summary ?? "",
      };
      if (candidate.snippet) {
        snippet.snippet = candidate.snippet;
      }
      if (candidate.matchedFields?.length) {
        snippet.matchedFields = candidate.matchedFields;
      }
      return snippet;
    }),
  };
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
