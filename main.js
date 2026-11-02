// Ruang Kirim (PC): kirim file antar perangkat di WiFi yang sama, terenkripsi ujung ke ujung.
"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, clipboard } = require("electron");
const path = require("path");
const QRCode = require("qrcode");
const { Core } = require("./lib/core");

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, tray = null, core = null, quitting = false;
const icon = () => { const p = path.join(__dirname, "build", "icon.png"); const i = nativeImage.createFromPath(p); return i.isEmpty() ? undefined : i; };

function createWindow() {
  win = new BrowserWindow({
    width: 1020, height: 720, minWidth: 420, minHeight: 520,
    title: "Ruang Kirim", icon: icon(), backgroundColor: "#f4efe6", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "app", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // tutup jendela = tetap menerima di tray (bisa dimatikan di Pengaturan)
  win.on("close", (e) => {
    if (!quitting && core && core.settings.tray) { e.preventDefault(); win.hide(); trayHint(); }
  });
  win.on("closed", () => { win = null; });
}
let hinted = false;
function trayHint() {
  if (hinted || !Notification.isSupported()) return;
  hinted = true;
  new Notification({ title: "Ruang Kirim tetap berjalan", body: "Masih bisa menerima file. Klik ikon di tray untuk membuka, atau Keluar dari menu tray.", icon: icon() }).show();
}
function show() { if (!win) createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function makeTray() {
  const i = icon();
  if (!i) return;
  tray = new Tray(i.resize({ width: 16, height: 16 }));
  tray.setToolTip("Ruang Kirim");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Buka Ruang Kirim", click: show },
    { label: "Buka folder terima", click: () => shell.openPath(core.settings.saveDir) },
    { type: "separator" },
    { label: "Keluar", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", show);
}

const send = (ch, v) => { if (win && !win.isDestroyed()) win.webContents.send(ch, v); };

app.on("second-instance", show);
app.whenReady().then(async () => {
  app.setAppUserModelId("id.sus.ruangkirim");
  core = new Core({
    file: path.join(app.getPath("userData"), "ruangkirim.json"),
    type: "pc",
    saveDir: path.join(app.getPath("downloads"), "RuangKirim"),
    onState: (s) => send("rk:state", s),
    onPrompt: (p) => {
      // ada yang mau mengirim / memasangkan: munculkan jendela & pemberitahuan
      if (!win || !win.isVisible() || !win.isFocused()) {
        if (Notification.isSupported()) {
          const n = new Notification({ title: p.kind === "pasang" ? "Permintaan pasangkan perangkat" : `${p.from.name} mau mengirim file`, body: p.kind === "pasang" ? `${p.from.name} · kode ${p.code}` : `${p.count} file · ${p.from.known ? "perangkat dikenal" : "BELUM DIKENAL"}`, icon: icon() });
          n.on("click", show);
          n.show();
        }
        show();
        if (win) win.flashFrame(true);
      }
    },
  });
  createWindow();
  makeTray();
  try { await core.start(); } catch (e) { dialog.showErrorBox("Ruang Kirim", "Tidak bisa mulai menerima: " + e.message); }
  send("rk:state", core.state());
});
app.on("before-quit", () => { quitting = true; if (core) core.stop(); });
app.on("window-all-closed", () => { if (!core || !core.settings.tray) app.quit(); });

// ---------- perintah dari tampilan ----------
const ACT = {
  state: () => core.state(),
  async send(id, paths) {
    if (!Array.isArray(paths) || !paths.length) {
      const r = await dialog.showOpenDialog(win, { title: "Pilih file yang mau dikirim", properties: ["openFile", "multiSelections"] });
      if (r.canceled || !r.filePaths.length) return null;
      paths = r.filePaths;
    }
    core.send(id, paths.map(String)).catch(() => {});
    return true;
  },
  async sendFolder(id) {
    const r = await dialog.showOpenDialog(win, { title: "Pilih folder yang mau dikirim", properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths.length) return null;
    core.send(id, r.filePaths).catch(() => {});
    return true;
  },
  pair: (id) => core.pair(id),
  pairCode: (text) => core.pairCode(text),
  async qr() {
    const q = core.qr();
    return { ...q, img: await QRCode.toDataURL(q.text, { margin: 1, width: 280, errorCorrectionLevel: "M" }) };
  },
  copyCode: () => { clipboard.writeText(core.qr().text); return true; },
  respond: (rid, yes) => core.respond(String(rid), !!yes),
  cancel: (tid) => core.cancel(String(tid)),
  forget: (id) => core.forget(String(id)),
  rename: (n) => core.rename(n),
  setting: (k, v) => core.setting(String(k), v),
  async chooseDir() {
    const r = await dialog.showOpenDialog(win, { title: "Folder untuk file yang diterima", defaultPath: core.settings.saveDir, properties: ["openDirectory", "createDirectory"] });
    if (!r.canceled && r.filePaths[0]) core.setting("saveDir", r.filePaths[0]);
    return core.settings.saveDir;
  },
  open(tid, i) {
    const t = core.transfers.find((x) => x.id === tid);
    const f = t && t.saved[+i || 0];
    if (f) shell.showItemInFolder(f);
    return !!f;
  },
  openDir: () => shell.openPath(core.settings.saveDir),
  addIp: (ip) => core.addIp(ip),
  rescan: () => core.rescan(),
  clearDone: () => core.clearDone(),
  version: () => app.getVersion(),
};
ipcMain.handle("rk:call", async (e, m, args) => {
  if (e.sender !== (win && win.webContents)) throw new Error("ditolak");
  const f = ACT[m];
  if (!f) throw new Error("perintah tidak dikenal");
  return f(...(Array.isArray(args) ? args : []));
});
