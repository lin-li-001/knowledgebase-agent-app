import type { ModelMessage } from "@kb-agent/model";

export interface RetrievedSnippet {
  provider?: string;
  sourceType?: string;
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
    ? `${currentUserMessage}\n\nRelevant local context:\n${retrievalBlock}\n\n${responseStyleInstruction()}`
    : `${currentUserMessage}\n\n${responseStyleInstruction()}`;

  return [...messages, { role: "user", content }];
}

function responseStyleInstruction(): string {
  return [
    "Response style:",
    "- Use short Markdown sections with `##` or `###` headings when the answer has multiple parts.",
    "- Prefer bullets or numbered lists over dense paragraphs.",
    "- Use fenced code blocks for SQL, commands, or snippets.",
    "- Keep each paragraph short and scannable.",
  ].join("\n");
}
