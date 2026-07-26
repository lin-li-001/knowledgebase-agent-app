import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppDatabase } from "@kb-agent/storage";
import { defaultRoutingPolicy } from "@kb-agent/workspace";
import { LocalNotesRecallProvider, type EvidenceBundle, type RecallProvider } from "./recallProvider";
import type { RetrievedSnippet } from "./requestMessages";

export interface TurnContext {
  workspaceRules: string;
  profile: string;
  memory: string;
  evidence: EvidenceBundle[];
  snippets: RetrievedSnippet[];
}

export async function buildTurnContext(input: {
  db: AppDatabase;
  workspaceId: string;
  workspaceRoot: string;
  activeProfileId?: string | undefined;
  query: string;
  recallProviders?: RecallProvider[];
}): Promise<TurnContext> {
  const recallProviders = input.recallProviders ?? [new LocalNotesRecallProvider()];
  const activeProfileId = input.activeProfileId ?? "default";
  const [workspaceRules, profile, memory, evidenceGroups] = await Promise.all([
    readOptional(path.join(input.workspaceRoot, "AGENTS.md")),
    readOptional(path.join(input.workspaceRoot, defaultRoutingPolicy.profilePath(activeProfileId))),
    readOptional(path.join(input.workspaceRoot, defaultRoutingPolicy.profileMemoryPath(activeProfileId))),
    Promise.all(recallProviders.map((provider) => provider.prefetch(input))),
  ]);
  const evidence = evidenceGroups.flat();

  return {
    workspaceRules,
    profile,
    memory,
    evidence,
    snippets: evidence.map((candidate) => {
      const snippet: RetrievedSnippet = {
        provider: candidate.provider,
        sourceType: candidate.sourceType,
        title: candidate.title,
        path: candidate.path,
        text: candidate.text,
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
