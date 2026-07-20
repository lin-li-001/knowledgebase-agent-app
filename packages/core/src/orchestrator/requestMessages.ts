import type { ModelMessage } from "@kb-agent/model";

export interface RetrievedSnippet {
  title: string;
  path: string;
  text: string;
}

export function buildRequestMessages(
  messages: ModelMessage[],
  currentUserMessage: string,
  snippets: RetrievedSnippet[],
): ModelMessage[] {
  const retrievalBlock = snippets
    .map((snippet) => `- ${snippet.title} (${snippet.path}): ${snippet.text}`)
    .join("\n");

  const content = retrievalBlock
    ? `${currentUserMessage}\n\nRelevant local context:\n${retrievalBlock}`
    : currentUserMessage;

  return [...messages, { role: "user", content }];
}
