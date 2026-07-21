import { app, BrowserWindow, safeStorage } from "electron";
import { ipcMain } from "electron";
import path from "node:path";
import { allowedChannels, handleIpcRequest, type IpcServices } from "./ipc";
import { createEncryptedFileSecretStore } from "./secureSettings";

const ipcServices: IpcServices = {
  activeTurns: new Set(),
  abortControllers: new Map(),
};

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: new URL("../preload/preload.js", import.meta.url).pathname,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(new URL("../renderer/index.html", import.meta.url).pathname);
  }
}

app.whenReady().then(createWindow);
const userDataPath = app.getPath("userData");
ipcServices.settingsPath = path.join(userDataPath, "settings.json");
ipcServices.secretStore = createEncryptedFileSecretStore(path.join(userDataPath, "secrets.json"), safeStorage);

for (const channel of allowedChannels) {
  ipcMain.handle(channel, async (_event, input) => handleIpcRequest(ipcServices, channel, input));
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
