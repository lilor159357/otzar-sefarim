import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("otzarDesktop", {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
  },
});
