export const allowedChannels = [
  "workspace:create",
  "workspace:open",
  "workspace:get-active",
  "workspace:audit",
  "workspace:tree",
  "workspace:read-file",
  "settings:get",
  "settings:update",
  "embedding:status",
  "chat:run-turn",
  "notes:search",
  "notes:read",
  "review:list",
  "review:approve",
  "review:reject",
  "categories:list",
  "categories:create",
  "activity:list",
  "index:rebuild",
  "import:start",
  "import:get-job",
  "chat:cancel-turn",
] as const;

export type IpcChannel = (typeof allowedChannels)[number];

export type IpcResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export function isAllowedChannel(channel: string): channel is IpcChannel {
  return (allowedChannels as readonly string[]).includes(channel);
}
