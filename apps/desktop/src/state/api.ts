import type { IpcChannel, IpcResult } from "../../electron/ipc";

export interface RendererApi {
  invoke<T = unknown>(channel: IpcChannel, input: unknown): Promise<IpcResult<T>>;
}

export function createRendererApi(
  invoke: (channel: IpcChannel, input: unknown) => Promise<IpcResult>,
): RendererApi {
  return {
    async invoke<T>(channel: IpcChannel, input: unknown) {
      return (await invoke(channel, input)) as IpcResult<T>;
    },
  };
}
