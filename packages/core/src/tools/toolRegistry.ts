import { z } from "zod";

export type ToolRiskCategory = "read" | "low" | "medium" | "high" | "explicit";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  jsonSchema: unknown;
  maxResultSize: number;
  riskCategory: ToolRiskCategory;
}

export const mvpToolNames = [
  "search_notes",
  "read_note",
  "list_notes",
  "search_sessions",
  "get_workspace_rules",
  "get_profile",
  "propose_create_note",
  "propose_update_note",
  "propose_memory",
  "propose_decision",
  "propose_delete",
] as const;

export type MvpToolName = (typeof mvpToolNames)[number];

export function createToolRegistry(): Map<MvpToolName, ToolDefinition> {
  const proposalSourceSchema = z.object({
    origin: z.string().optional(),
    userMessage: z.string().optional(),
    assistantMessage: z.string().optional(),
    reason: z.string().optional(),
  }).optional();

  const definitions = [
    tool("search_notes", "Search indexed Markdown notes.", z.object({ query: z.string() }), "read"),
    tool("read_note", "Read a Markdown note by workspace-relative path.", z.object({ path: z.string() }), "read"),
    tool("list_notes", "List indexed Markdown notes.", z.object({ limit: z.number().optional() }), "read"),
    tool("search_sessions", "Search prior chat session messages.", z.object({ query: z.string() }), "read"),
    tool("get_workspace_rules", "Read workspace AGENTS.md rules.", z.object({}), "read"),
    tool("get_profile", "Read active profile context.", z.object({}), "read"),
    tool("propose_create_note", "Propose creating a Markdown note.", z.object({ path: z.string(), body: z.string(), source: proposalSourceSchema }), "low"),
    tool("propose_update_note", "Propose updating an existing Markdown note.", z.object({ path: z.string(), patch: z.unknown(), source: proposalSourceSchema }), "medium"),
    tool("propose_memory", "Propose durable memory.", z.object({ body: z.string(), source: proposalSourceSchema }), "high"),
    tool("propose_decision", "Propose a durable decision note.", z.object({ body: z.string(), source: proposalSourceSchema }), "high"),
    tool("propose_delete", "Propose deleting a note.", z.object({ path: z.string() }), "explicit"),
  ];

  return new Map(definitions.map((definition) => [definition.name as MvpToolName, definition]));
}

function tool(
  name: MvpToolName,
  description: string,
  parameters: z.ZodTypeAny,
  riskCategory: ToolRiskCategory,
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    jsonSchema: z.toJSONSchema(parameters),
    maxResultSize: 8_000,
    riskCategory,
  };
}
