// Mesin Ruang Kirim versi PC: identitas, perangkat dikenal, pencarian di WiFi (UDP), server penerima (TCP),
// kirim/terima file, dan permintaan Ya/Tidak. Tampilan cukup membaca state() dan memanggil metode di sini.
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const dgram = require("dgram");
const crypto = require("crypto");
const { Identity, handshake, idOf, fmtId, validPub, CHUNK, T_DATA } = require("./proto");

const UDP_PORT = 47820, TCP_PORT = 47821;
const ONLINE_MS = 15000;
const PROMPT_MS = 90000;
const QR_MS = 5 * 60000;

const cleanIp = (a) => String(a || "").replace(/^::ffff:/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// nama file aman: tanpa garis miring, tanpa "..", tanpa karakter terlarang Windows
function safeName(n) {
  let s = String(n || "").replace(/[\u0000-\u001f<>:"|?*\\/]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 180);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = "_" + s;
  return s || "file";
}
// jalur relatif aman (untuk kiriman folder): tiap bagian dibersihkan
const safeRel = (r) => String(r || "").split(/[\\/]+/).filter((x) => x && x !== "." && x !== "..").map(safeName).slice(-12).join(path.sep) || "file";

class Core {
  constructor(opts) {
    this.file = opts.file;
    this.type = opts.type || "pc";
    this.udpPort = opts.udpPort || UDP_PORT;
    this.tcpPort = opts.tcpPort ?? TCP_PORT;
    this.onState = opts.onState || (() => {});
    this.onPrompt = opts.onPrompt || (() => {});
    this.defaults = { name: opts.name || os.hostname(), saveDir: opts.saveDir || path.join(os.homedir(), "Downloads", "RuangKirim"), autoKnown: false, onlyKnown: false, tray: true };
    this.nearby = new Map();
    this.transfers = [];
    this.prompts = new Map();
    this.seq = 0;
    this.qrTok = null; this.qrExp = 0;
    this.port = 0;
    this.load();
  }

  // ---------- simpan / muat ----------
  load() {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch {}
    this.me = new Identity(c.priv || null);
    this.cfg = { priv: this.me.privB64, settings: { ...this.defaults, ...(c.settings || {}) }, known: c.known || {} };
    if (!c.priv) this.save();
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.cfg, null, 1));
      fs.renameSync(this.file + ".tmp", this.file);
    } catch {}
  }
  get settings() { return this.cfg.settings; }
  info() { return { name: this.settings.name, type: this.type, port: this.port }; }

  // ---------- mulai ----------
  async start() {
    await this.listen();
    this.discovery();
    this.tick = setInterval(() => { this.announce("hai"); this.emit(); }, 4000);
    this.announce("cari");
  }
  stop() {
    clearInterval(this.tick);
    try { this.server.close(); } catch {}
    try { this.udp.close(); } catch {}
  }
  listen() {
    return new Promise((res) => {
      const srv = net.createServer((s) => this.incoming(s).catch(() => {}));
      srv.on("error", (e) => {
        if (e.code === "EADDRINUSE" && this.port !== 0) { this.port = 0; srv.listen(0); } // port bawaan dipakai aplikasi lain
      });
      srv.listen(this.tcpPort, () => { this.port = srv.address().port; this.server = srv; res(); });
      this.port = this.tcpPort;
    });
  }

  // ---------- pencarian di WiFi ----------
  ips() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || /^169\.254\./.test(a.address)) continue;
      if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|br-|veth/i.test(name)) continue;
      out.push({ ip: a.address, mask: a.netmask });
    }
    return out;
  }
  broadcasts() {
    const set = new Set(["255.255.255.255"]);
    for (const { ip, mask } of this.ips()) {
      const a = ip.split(".").map(Number), m = String(mask).split(".").map(Number);
      if (a.length === 4 && m.length === 4) set.add(a.map((x, i) => (x | (~m[i] & 255)) & 255).join("."));
    }
    return [...set];
  }
  discovery() {
    const u = dgram.createSocket({ type: "udp4", reuseAddr: true });
    u.on("error", () => {});
    u.on("message", (msg, r) => {
      let j; try { j = JSON.parse(msg.toString("utf8")); } catch { return; }
      if (!j || j.rk !== 1 || typeof j.id !== "string" || j.id === this.me.id || !/^[0-9a-f]{16}$/.test(j.id)) return;
      this.seen({ id: j.id, name: String(j.name || "Perangkat").slice(0, 60), type: j.type === "hp" ? "hp" : "pc", port: +j.port || TCP_PORT }, cleanIp(r.address));
      if (j.t === "cari") this.udpSend("hai", r.address);
    });
    u.bind(this.udpPort, () => { try { u.setBroadcast(true); } catch {} });
    this.udp = u;
  }
  udpSend(t, addr) {
    const m = Buffer.from(JSON.stringify({ rk: 1, t, id: this.me.id, name: this.settings.name, type: this.type, port: this.port }));
    try { this.udp.send(m, this.udpPort, addr); } catch {}
  }
  announce(t) { for (const b of this.broadcasts()) this.udpSend(t, b); }
  rescan() { for (const [k, d] of this.nearby) if (Date.now() - d.seen > 5000) this.nearby.delete(k); this.announce("cari"); this.emit(); }
  seen(p, ip) {
    if (!ip || p.id === this.me.id) return;
    const d = this.nearby.get(p.id) || {};
    this.nearby.set(p.id, { id: p.id, name: p.name, type: p.type, ip, port: p.port || d.port || TCP_PORT, seen: Date.now() });
    const k = this.cfg.known[p.id];
    if (k && (k.ip !== ip || k.name !== p.name || (p.port && k.port !== p.port))) { Object.assign(k, { ip, name: p.name, port: p.port || k.port }); this.save(); }
    this.emit();
  }

  // ---------- state untuk tampilan ----------
  devices() {
    const now = Date.now(), out = new Map();
    for (const k of Object.values(this.cfg.known)) out.set(k.id, { id: k.id, name: k.name, type: k.type, ip: k.ip || "", port: k.port || TCP_PORT, known: true, online: false, fp: fmtId(k.id) });
    for (const d of this.nearby.values()) {
      const on = now - d.seen < ONLINE_MS;
      if (!on && !out.has(d.id)) continue;
      out.set(d.id, { ...(out.get(d.id) || { known: false, fp: fmtId(d.id) }), id: d.id, name: d.name, type: d.type, ip: d.ip, port: d.port, online: on });
    }
    return [...out.values()].sort((a, b) => (b.online - a.online) || (b.known - a.known) || a.name.localeCompare(b.name));
  }
  state() {
    return {
      me: { id: this.me.id, fp: fmtId(this.me.id), name: this.settings.name, type: this.type, port: this.port, ips: this.ips().map((x) => x.ip) },
      settings: { ...this.settings },
      devices: this.devices(),
      transfers: this.transfers.map((t) => ({ id: t.id, dir: t.dir, peer: t.peer, files: t.files.slice(0, 50), count: t.files.length, total: t.total, done: t.done, status: t.status, err: t.err || "", speed: t.speed || 0, current: t.current || "", saved: t.saved || [], at: t.at, known: !!t.known })),
      prompts: [...this.prompts.values()].map((p) => p.data),
    };
  }
  emit() {
    if (this.emitT) return;
    this.emitT = setTimeout(() => { this.emitT = null; this.onState(this.state()); }, 120);
  }

  // ---------- permintaan Ya/Tidak ----------
  ask(data, sock) {
    const rid = "p" + ++this.seq;
    data = { ...data, rid, expires: Date.now() + PROMPT_MS };
    return new Promise((res) => {
      const done = (v) => { if (!this.prompts.has(rid)) return; clearTimeout(t); this.prompts.delete(rid); this.emit(); res(v); };
      const t = setTimeout(() => done(false), PROMPT_MS);
      sock.once("close", () => done(false));
      this.prompts.set(rid, { data, done });
      this.emit();
      this.onPrompt(data);
    });
  }
  respond(rid, yes) { const p = this.prompts.get(rid); if (p) p.done(!!yes); }

  // ---------- perangkat dikenal ----------
  isKnown(id) { return !!this.cfg.known[id]; }
  addKnown(peer, ip) {
    this.cfg.known[peer.id] = { id: peer.id, name: peer.name, type: peer.type, pub: peer.pub, ip, port: peer.port || TCP_PORT, added: Date.now() };
    this.save(); this.emit();
  }
  forget(id) { delete this.cfg.known[id]; this.save(); this.emit(); }
  rename(name) { name = String(name || "").trim().slice(0, 40); if (!name) return; this.settings.name = name; this.save(); this.announce("hai"); this.emit(); }
  setting(k, v) {
    if (!["autoKnown", "onlyKnown", "tray", "saveDir"].includes(k)) return;
    this.settings[k] = k === "saveDir" ? String(v) : !!v;
    this.save(); this.emit();
  }

  // ---------- kode QR untuk dipindai HP ----------
  qr() {
    if (!this.qrTok || Date.now() > this.qrExp) { this.qrTok = crypto.randomBytes(16).toString("hex"); this.qrExp = Date.now() + QR_MS; }
    const j = { k: this.me.pub.toString("base64"), n: this.settings.name, a: this.ips().map((x) => x.ip), p: this.port, t: this.qrTok };
    return { text: "RK1:" + Buffer.from(JSON.stringify(j)).toString("base64url"), expires: this.qrExp };
  }

  // ---------- sambung keluar ----------
  connect(ip, port, ms = 8000) {
    return new Promise((res, rej) => {
      const s = net.connect({ host: ip, port });
      const t = setTimeout(() => { s.destroy(); rej(new Error(`Tidak bisa menyambung ke ${ip}. Pastikan satu WiFi dan Ruang Kirim terbuka di sana.`)); }, ms);
      s.once("connect", () => { clearTimeout(t); s.setNoDelay(true); res(s); });
      s.once("error", (e) => { clearTimeout(t); rej(new Error(e.code === "ECONNREFUSED" ? `Ruang Kirim tidak terbuka di ${ip}.` : `Tidak bisa menyambung ke ${ip} (${e.code || e.message}).`)); });
    });
  }
  async open(ip, port, wantId) {
    const sock = await this.connect(ip, port);
    try {
      const h = await handshake(sock, this.me, this.info(), "c");
      if (wantId && h.peer.id !== wantId) throw new Error("Perangkat di alamat itu bukan perangkat yang dipilih (alamatnya mungkin berubah). Coba Cari ulang.");
      this.seen(h.peer, ip);
      return { ...h, sock };
    } catch (e) { sock.destroy(); throw e; }
  }
  target(id) {
    const d = this.nearby.get(id), k = this.cfg.known[id];
    const ip = (d && d.ip) || (k && k.ip), port = (d && d.port) || (k && k.port) || TCP_PORT;
    if (!ip) throw new Error("Alamat perangkat belum diketahui. Buka Ruang Kirim di perangkat itu, lalu Cari ulang.");
    return { ip, port };
  }

  // Tambah perangkat lewat alamat IP (kalau router memblok pencarian otomatis)
  async addIp(text) {
    const m = String(text || "").trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
    if (!m) throw new Error("Tulis alamat seperti 192.168.1.7");
    const c = await this.open(m[1], +(m[2] || TCP_PORT));
    try { await c.sess.sendJson({ t: "tutup" }); } catch {}
    c.sess.close();
    return c.peer.name;
  }

  // Pasangkan dengan membandingkan kode 6 digit di kedua layar
  async pair(id) {
    const { ip, port } = this.target(id);
    const c = await this.open(ip, port, id);
    const pend = { rid: "w" + ++this.seq, kind: "tunggu", from: { id, name: c.peer.name, type: c.peer.type }, code: c.code };
    this.prompts.set(pend.rid, { data: pend, done: () => { c.sock.destroy(); } });
    this.emit();
    try {
      await c.sess.sendJson({ t: "pasang" });
      const r = await c.sess.recv(PROMPT_MS + 5000);
      if (r.json && r.json.t === "dipasang") { this.addKnown(c.peer, ip); return c.peer.name; }
      throw new Error(r.json && r.json.why ? r.json.why : "Pemasangan ditolak");
    } catch (e) {
      if (!this.prompts.has(pend.rid)) throw new Error("Pemasangan dibatalkan");
      throw e;
    } finally { this.prompts.delete(pend.rid); this.emit(); c.sess.close(); }
  }

  // Pasangkan dengan kode QR / teks kode dari perangkat lain
  async pairCode(text) {
    const m = String(text || "").trim().match(/^RK1:([A-Za-z0-9_-]+)$/);
    if (!m) throw new Error("Kode tidak dikenali. Kode Ruang Kirim diawali RK1:");
    let j; try { j = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")); } catch { throw new Error("Kode rusak"); }
    const pub = Buffer.from(String(j.k || ""), "base64");
    if (!validPub(pub)) throw new Error("Kode rusak");
    const id = idOf(pub);
    let last = null;
    for (const ip of (Array.isArray(j.a) ? j.a : []).slice(0, 6)) {
      let c;
      try { c = await this.open(String(ip), +j.p || TCP_PORT, id); } catch (e) { last = e; continue; }
      try {
        await c.sess.sendJson({ t: "pasang", tok: String(j.t || "") });
        const r = await c.sess.recv(PROMPT_MS + 5000);
        if (r.json && r.json.t === "dipasang") { this.addKnown(c.peer, String(ip)); return c.peer.name; }
        throw new Error(r.json && r.json.why ? r.json.why : "Pemasangan ditolak");
      } finally { c.sess.close(); }
    }
    throw last || new Error("Perangkat dari kode itu tidak ditemukan di WiFi ini");
  }

  // ---------- kirim file ----------
  listFiles(paths) {
    const out = [];
    const walk = (abs, rel) => {
      let st; try { st = fs.statSync(abs); } catch { return; }
      if (st.isDirectory()) { for (const n of fs.readdirSync(abs)) walk(path.join(abs, n), rel + "/" + n); if (out.length > 5000) throw new Error("Terlalu banyak file (maks. 5000)"); }
      else if (st.isFile()) out.push({ abs, n: rel, s: st.size });
    };
    for (const p of paths) walk(p, path.basename(p));
    return out;
  }
  newTransfer(dir, peer, files, known) {
    const t = { id: "t" + ++this.seq, dir, peer: { id: peer.id, name: peer.name, type: peer.type }, files: files.map((f) => ({ n: f.n, s: f.s })), total: files.reduce((a, f) => a + f.s, 0), done: 0, status: "menyambung", at: Date.now(), known, saved: [] };
    this.transfers.unshift(t);
    if (this.transfers.length > 60) this.transfers.length = 60;
    this.emit();
    return t;
  }
  progress(t, n) {
    t.done += n;
    const now = Date.now();
    if (!t.t0) { t.t0 = now; t.b0 = 0; }
    if (now - (t.tl || 0) > 500) {
      const dt = (now - (t.tl || t.t0)) / 1000;
      if (dt > 0) t.speed = Math.round(((t.done - (t.dl || 0)) / dt) * 0.6 + (t.speed || 0) * 0.4);
      t.tl = now; t.dl = t.done;
      this.emit();
    }
  }
  cancel(tid) {
    const t = this.transfers.find((x) => x.id === tid);
    if (!t || !["menyambung", "menunggu", "jalan"].includes(t.status)) return;
    t.cancelled = true;
    for (const p of this.prompts.values()) if (p.data.tid === tid) p.done(false);
    const ss = t.sess;
    if (ss) { ss.sendJson({ t: "batal" }).catch(() => {}).finally(() => setTimeout(() => ss.sock.destroy(), 300)); }
    t.status = "batal"; this.emit();
  }
  clearDone() { this.transfers = this.transfers.filter((t) => ["menyambung", "menunggu", "jalan"].includes(t.status)); this.emit(); }

  async send(id, paths) {
    const files = this.listFiles(paths);
    if (!files.length) throw new Error("Tidak ada file untuk dikirim");
    const dev = this.devices().find((d) => d.id === id) || { id, name: "Perangkat", type: "pc" };
    const t = this.newTransfer("kirim", dev, files, this.isKnown(id));
    let c;
    try {
      const { ip, port } = this.target(id);
      c = await this.open(ip, port, id);
      t.sess = c.sess; t.peer.name = c.peer.name;
      if (t.cancelled) throw new Error("batal");
      t.status = "menunggu"; this.emit();
      await c.sess.sendJson({ t: "kirim", files: files.map((f) => ({ n: f.n, s: f.s })), total: t.total });
      const r = await c.sess.recv(PROMPT_MS + 10000);
      if (!r.json || r.json.t !== "terima") { t.status = "ditolak"; t.err = (r.json && r.json.why) || "Ditolak"; return this.emit(); }
      t.status = "jalan"; this.emit();
      for (const f of files) {
        t.current = f.n;
        let sent = 0;
        const rs = fs.createReadStream(f.abs, { highWaterMark: CHUNK });
        try {
          for await (const chunk of rs) {
            if (t.cancelled) throw new Error("batal");
            const part = chunk.subarray(0, Math.max(0, f.s - sent)); // file berubah ukuran saat dikirim
            if (part.length) await c.sess.send(T_DATA, part);
            sent += part.length;
            this.progress(t, part.length);
            if (c.sess.framer.q.length) { const m = await c.sess.recv(1000); if (m.json && m.json.t === "batal") throw new Error("Dibatalkan oleh penerima"); }
            if (sent >= f.s) break;
          }
        } finally { rs.destroy(); }
        if (sent < f.s) throw new Error(`File ${f.n} berubah saat dikirim`);
      }
      await c.sess.sendJson({ t: "selesai" });
      const ok = await c.sess.recv(60000);
      if (!ok.json || ok.json.t !== "ok") throw new Error((ok.json && ok.json.why) || "Penerima tidak mengonfirmasi");
      t.status = "selesai"; t.current = ""; this.emit();
    } catch (e) {
      if (t.status !== "batal") { t.status = t.cancelled || /^Dibatalkan/.test(e.message) ? "batal" : "gagal"; t.err = t.cancelled ? "" : e.message; }
      this.emit();
    } finally { t.sess = null; if (c) c.sess.close(); }
  }

  // ---------- sambungan masuk ----------
  async incoming(sock) {
    sock.setNoDelay(true);
    sock.setTimeout(120000, () => sock.destroy());
    const ip = cleanIp(sock.remoteAddress);
    let h;
    try { h = await handshake(sock, this.me, this.info(), "s"); } catch { sock.destroy(); return; }
    const { sess, peer, code } = h;
    this.seen(peer, ip);
    try {
      const m = await sess.recv(30000);
      const j = m.json || {};
      if (j.t === "pasang") await this.inPair(sess, peer, code, j, ip, sock);
      else if (j.t === "kirim") await this.inReceive(sess, peer, code, j, ip, sock);
    } catch {} finally { sess.close(); }
  }

  async inPair(sess, peer, code, j, ip, sock) {
    let yes = false;
    const tok = String(j.tok || "");
    if (tok && this.qrTok && Date.now() < this.qrExp && tok.length === this.qrTok.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(this.qrTok))) {
      yes = true; this.qrTok = null; // kode QR sekali pakai
    } else if (tok) {
      return sess.sendJson({ t: "tolak", why: "Kode QR sudah kedaluwarsa. Buka kode baru di PC lalu pindai lagi." });
    } else {
      yes = await this.ask({ kind: "pasang", from: { id: peer.id, name: peer.name, type: peer.type, ip, fp: fmtId(peer.id), known: this.isKnown(peer.id) }, code }, sock);
    }
    if (!yes) return sess.sendJson({ t: "tolak", why: "Pemasangan ditolak di perangkat tujuan" });
    this.addKnown(peer, ip);
    await sess.sendJson({ t: "dipasang", name: this.settings.name });
  }

  async inReceive(sess, peer, code, j, ip, sock) {
    const raw = Array.isArray(j.files) ? j.files : [];
    if (!raw.length || raw.length > 5000) return sess.sendJson({ t: "tolak", why: "Daftar file tidak sah" });
    const files = raw.map((f) => ({ n: safeRel(f && f.n), s: Math.floor(+(f && f.s)) }));
    if (files.some((f) => !(f.s >= 0) || f.s > 2 ** 42)) return sess.sendJson({ t: "tolak", why: "Ukuran file tidak sah" });
    const known = this.isKnown(peer.id);
    if (this.settings.onlyKnown && !known) return sess.sendJson({ t: "tolak", why: "Perangkat tujuan hanya menerima dari perangkat dikenal" });
    const t = this.newTransfer("terima", peer, files, known);
    t.status = "menunggu"; t.sess = sess;
    const total = files.reduce((a, f) => a + f.s, 0);
    const yes = known && this.settings.autoKnown ? true
      : await this.ask({ kind: "kirim", from: { id: peer.id, name: peer.name, type: peer.type, ip, fp: fmtId(peer.id), known }, code, files: files.slice(0, 30).map((f) => ({ n: f.n, s: f.s })), count: files.length, total, tid: t.id }, sock);
    if (!yes || t.cancelled) {
      t.status = "ditolak"; t.sess = null; this.emit();
      return sess.sendJson({ t: "tolak", why: t.cancelled ? "Dibatalkan" : "Ditolak oleh penerima" }).catch(() => {});
    }
    const dir = this.settings.saveDir;
    let tmp = null, ws = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      await sess.sendJson({ t: "terima" });
      t.status = "jalan"; this.emit();
      for (const f of files) {
        t.current = f.n;
        const final = this.uniquePath(path.join(dir, f.n));
        fs.mkdirSync(path.dirname(final), { recursive: true });
        tmp = final + ".rkpart";
        ws = fs.createWriteStream(tmp);
        let left = f.s;
        while (left > 0) {
          const m = await sess.recv(60000);
          if (t.cancelled) throw new Error("batal");
          if (m.json) throw new Error(m.json.t === "batal" ? "Dibatalkan oleh pengirim" : "Pesan tidak terduga");
          if (m.data.length > left) throw new Error("Data melebihi ukuran file");
          if (!ws.write(m.data)) await new Promise((r) => ws.once("drain", r));
          left -= m.data.length;
          this.progress(t, m.data.length);
        }
        await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
        ws = null;
        fs.renameSync(tmp, final);
        tmp = null;
        t.saved.push(final);
      }
      const end = await sess.recv(60000);
      if (!end.json || end.json.t !== "selesai") throw new Error("Pengirim berhenti sebelum selesai");
      await sess.sendJson({ t: "ok" });
      t.status = "selesai"; t.current = ""; this.emit();
    } catch (e) {
      if (ws) ws.destroy();
      if (tmp) { await sleep(50); try { fs.unlinkSync(tmp); } catch {} }
      if (t.status !== "batal") { t.status = /^Dibatalkan/.test(e.message) ? "batal" : "gagal"; t.err = e.message; }
      this.emit();
    } finally { t.sess = null; }
  }
  uniquePath(p) {
    if (!fs.existsSync(p) && !fs.existsSync(p + ".rkpart")) return p;
    const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
    for (let i = 1; i < 10000; i++) { const q = `${base} (${i})${ext}`; if (!fs.existsSync(q) && !fs.existsSync(q + ".rkpart")) return q; }
    return `${base}-${Date.now()}${ext}`;
  }
}

module.exports = { Core, UDP_PORT, TCP_PORT, safeName, safeRel };
