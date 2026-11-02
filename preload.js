// Jembatan tampilan ↔ aplikasi (versi PC). Tampilan yang sama dipakai versi HP lewat rk-hp.js.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("RK", {
  platform: "pc",
  call: (m, ...a) => ipcRenderer.invoke("rk:call", m, a).catch((e) => { throw new Error(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }),
  onState: (cb) => ipcRenderer.on("rk:state", (_e, s) => cb(s)),
  // jalur file yang diseret ke jendela
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
});
