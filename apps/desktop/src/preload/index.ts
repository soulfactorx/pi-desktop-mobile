import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { createPiDesktopApi } from "../shared/api-client";

const api = createPiDesktopApi(
  {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    on: (channel, listener) => {
      const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  "electron",
);

contextBridge.exposeInMainWorld("piDesktop", api);
