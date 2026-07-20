import { app, BrowserWindow } from "electron";

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: new URL("./preload.js", import.meta.url).pathname,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(new URL("../renderer/index.html", import.meta.url).pathname);
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
