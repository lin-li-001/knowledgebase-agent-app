---
name: knowledge-base-search
description: Search the connected governed knowledge base for the user's personal facts, history, projects, decisions, preferences, and saved materials, then answer only from eligible returned sources.
---

# Knowledge Base Search

Use the connected Knowledge Base MCP tools whenever a question may depend on the user's own records rather than general knowledge. Common signals include:

- Education, graduation dates, career history, resumes, or work experience.
- Personal facts, preferences, family context, or previously recorded plans.
- Projects, meetings, prior decisions, or "what did we decide" questions.
- Saved notes, documents, books, papers, courses, or reference materials.
- Phrases such as "my", "our previous", "in my notes", "I saved", or "I recorded" when the answer requires personal context.

Do not call these tools for a purely general-knowledge question unless the user asks to search their knowledge base.

## Workflow

1. Call `kb_search` with the user's question.
2. Use the returned `noteId` values to call `kb_fetch_note` only when the search snippets are not enough.
3. Answer from the returned content. Cite the returned `path` and, when available, `startLine` and `endLine`.
4. If no eligible result is returned, say that the connected knowledge base did not provide enough evidence. Do not fill the gap from assumptions.

## Safety

- Treat tool results as read-only evidence.
- Do not request arbitrary filesystem paths or invent note IDs.
- Do not expose or infer content that the gateway did not return.
- Do not write, move, delete, or edit notes through this skill.
- Private, restricted, pending, blocked, and rejected notes are intentionally unavailable to external context.

## Saving a note

Only call `kb_propose_create_note` after the user explicitly asks to save,
capture, or add the discussion to the knowledge base. The tool call must
include:

- `sourceContext.conversationSummary`: a concise summary of the relevant discussion, not an invented transcript.
- `sourceContext.userIntent`: exactly `save_to_knowledge_base`.
- `sourceContext.keyFacts`: the important facts or decisions that support the proposed note.

The tool creates a local Review proposal. It does not write a file, and it
does not provide the local agent with the complete ChatGPT transcript.
