import { contextBridge, ipcRenderer } from "electron";
import { allowedChannels, type IpcChannel } from "./ipcContract";

contextBridge.exposeInMainWorld("kbAgent", {
  version: "0.1.0",
  invoke(channel: IpcChannel, input: unknown) {
    if (!allowedChannels.includes(channel)) {
      throw new Error("Unknown IPC channel");
    }

    return ipcRenderer.invoke(channel, input);
  },
});
