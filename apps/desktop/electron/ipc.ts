import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertInsideWorkspace, createWorkspace } from "@kb-agent/workspace";

export const allowedChannels = [
  "workspace:create",
  "workspace:open",
  "workspace:get-active",
  "settings:get",
  "settings:update",
  "chat:run-turn",
  "notes:search",
  "notes:read",
  "review:list",
  "review:approve",
  "review:reject",
  "activity:list",
  "index:rebuild",
  "chat:cancel-turn",
] as const;

export type IpcChannel = (typeof allowedChannels)[number];

export interface IpcServices {
  workspaceRoot?: string;
  activeTurns: Set<string>;
}

export type IpcResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

const schemas: Record<IpcChannel, z.ZodTypeAny> = {
  "workspace:create": z.object({ rootPath: z.string() }),
  "workspace:open": z.object({ rootPath: z.string() }),
  "workspace:get-active": z.object({}),
  "settings:get": z.object({}),
  "settings:update": z.record(z.string(), z.unknown()),
  "chat:run-turn": z.object({ sessionId: z.string(), message: z.string() }),
  "notes:search": z.object({ query: z.string() }),
  "notes:read": z.object({ path: z.string() }),
  "review:list": z.object({}),
  "review:approve": z.object({ id: z.string() }),
  "review:reject": z.object({ id: z.string() }),
  "activity:list": z.object({}),
  "index:rebuild": z.object({}),
  "chat:cancel-turn": z.object({ sessionId: z.string() }),
};

export function isAllowedChannel(channel: string): channel is IpcChannel {
  return (allowedChannels as readonly string[]).includes(channel);
}

export async function handleIpcRequest(
  services: IpcServices,
  channel: string,
  input: unknown,
): Promise<IpcResult> {
  try {
    if (!isAllowedChannel(channel)) {
      return { ok: false, error: "Unknown IPC channel" };
    }

    const payload = schemas[channel].parse(input) as Record<string, unknown>;

    switch (channel) {
      case "workspace:create": {
        const workspace = await createWorkspace(payload.rootPath as string);
        services.workspaceRoot = workspace.rootPath;
        return { ok: true, data: workspace };
      }
      case "workspace:open": {
        services.workspaceRoot = path.resolve(payload.rootPath as string);
        return { ok: true, data: { rootPath: services.workspaceRoot } };
      }
      case "workspace:get-active":
        return { ok: true, data: services.workspaceRoot ? { rootPath: services.workspaceRoot } : null };
      case "notes:read": {
        const root = requireWorkspaceRoot(services);
        const targetPath = assertInsideWorkspace(root, payload.path as string);
        return { ok: true, data: { path: payload.path, content: await readFile(targetPath, "utf8") } };
      }
      case "chat:cancel-turn": {
        services.activeTurns.delete(payload.sessionId as string);
        return { ok: true, data: { interrupted: true } };
      }
      default:
        return { ok: true, data: null };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function requireWorkspaceRoot(services: IpcServices): string {
  if (!services.workspaceRoot) {
    throw new Error("No active workspace");
  }

  return services.workspaceRoot;
}
