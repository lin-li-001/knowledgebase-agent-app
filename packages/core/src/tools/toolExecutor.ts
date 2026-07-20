import type { MvpToolName, ToolDefinition } from "./toolRegistry";

export type ToolHandler = (input: unknown) => Promise<unknown>;

export async function executeToolCall(
  registry: Map<MvpToolName, ToolDefinition>,
  handlers: Map<MvpToolName, ToolHandler>,
  name: string,
  input: unknown,
): Promise<unknown> {
  const definition = registry.get(name as MvpToolName);
  if (!definition) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const parsedInput = definition.parameters.parse(input);
  const handler = handlers.get(definition.name as MvpToolName);
  if (!handler) {
    throw new Error(`Missing handler for tool: ${name}`);
  }

  return handler(parsedInput);
}
