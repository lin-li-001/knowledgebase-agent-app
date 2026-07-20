import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allowedChannels, handleIpcRequest, isAllowedChannel, type IpcServices } from "../electron/ipc";

describe("IPC contract", () => {
  it("does not expose unknown channels", () => {
    expect(allowedChannels).not.toContain("shell:exec");
    expect(isAllowedChannel("shell:exec")).toBe(false);
  });

  it("rejects notes:read paths that escape the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kb-agent-ipc-"));
    await mkdir(path.join(root, "00-Inbox"), { recursive: true });
    await writeFile(path.join(root, "00-Inbox/Note.md"), "hello", "utf8");
    const services: IpcServices = { workspaceRoot: root, activeTurns: new Set() };

    await expect(handleIpcRequest(services, "notes:read", { path: "00-Inbox/Note.md" })).resolves.toEqual(
      { ok: true, data: { path: "00-Inbox/Note.md", content: "hello" } },
    );
    await expect(handleIpcRequest(services, "notes:read", { path: "../outside.md" })).resolves.toEqual(
      { ok: false, error: "Path escapes workspace" },
    );
  });

  it("cancels an active chat turn", async () => {
    const services: IpcServices = { activeTurns: new Set(["session-1"]) };

    await expect(handleIpcRequest(services, "chat:cancel-turn", { sessionId: "session-1" })).resolves.toEqual(
      { ok: true, data: { interrupted: true } },
    );
    expect(services.activeTurns.has("session-1")).toBe(false);
  });
});
