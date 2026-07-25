import type { ModelMessage } from "@kb-agent/model";

export interface RetrievedSnippet {
  title: string;
  path: string;
  text: string;
  snippet?: string;
  matchedFields?: string[];
}

export function buildRequestMessages(
  messages: ModelMessage[],
  currentUserMessage: string,
  snippets: RetrievedSnippet[],
): ModelMessage[] {
  const retrievalBlock = snippets
    .map((snippet) => {
      const evidence = snippet.snippet || snippet.text;
      const matchedFields = snippet.matchedFields?.length ? `\n  Matched fields: ${snippet.matchedFields.join(", ")}` : "";
      return `- ${snippet.title}\n  Source: ${snippet.path}\n  Evidence: ${evidence}${matchedFields}`;
    })
    .join("\n");

  const content = retrievalBlock
    ? `${currentUserMessage}\n\nRelevant local context:\n${retrievalBlock}`
    : currentUserMessage;

  return [...messages, { role: "user", content }];
}
