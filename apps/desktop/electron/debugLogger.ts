import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface DebugLogEvent {
  channel: string;
  ok: boolean;
  durationMs: number;
  workspaceRoot?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export async function appendDebugLog(logPath: string | undefined, event: DebugLogEvent): Promise<void> {
  if (!logPath) {
    return;
  }

  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, "utf8");
}
