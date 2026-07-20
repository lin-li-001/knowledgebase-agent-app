import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("kbAgent", {
  version: "0.1.0",
});
