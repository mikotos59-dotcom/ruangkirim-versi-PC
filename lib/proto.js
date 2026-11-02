// Protokol Ruang Kirim v1 (sama persis dengan Proto.java di versi HP). Lihat PROTOKOL.md.
//  - Identitas: kunci ECDH P-256 tetap per perangkat; id = 16 hex pertama SHA-256(kunci publik).
//  - Sambungan TCP: tiap frame = u32 panjang (big-endian) + isi.
//  - Jabat tangan: kedua pihak mengirim "hai" (JSON) berisi kunci tetap + kunci sementara.
//    ikm = ECDH(sementara, sementara) || ECDH(tetap, tetap); salt = SHA-256(transkrip)
//    kunci tiap arah = HKDF-SHA256(ikm, salt, "rk1 c2s" / "rk1 s2c"); kode cocok 6 digit dari "rk1 kode".
//  - Setelah itu semua frame terenkripsi AES-256-GCM, nonce = 4 byte nol + penghitung 8 byte.
//    Isi terenkripsi = 1 byte jenis (1 = JSON, 2 = data file) + muatan.
"use strict";
const crypto = require("crypto");

const MAX_FRAME = 1 << 20;   // 1 MB
const CHUNK = 256 * 1024;    // potongan data file
const T_JSON = 1, T_DATA = 2;
const SPKI_P256 = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

const sha256 = (...b) => { const h = crypto.createHash("sha256"); for (const x of b) h.update(x); return h.digest(); };
const idOf = (pub) => sha256(pub).toString("hex").slice(0, 16);
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), len));
const fmtId = (id) => String(id || "").toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");

class Identity {
  constructor(privB64) {
    this.ecdh = crypto.createECDH("prime256v1");
    if (privB64) this.ecdh.setPrivateKey(Buffer.from(privB64, "base64"));
    else this.ecdh.generateKeys();
    this.pub = this.ecdh.getPublicKey(); // 65 byte, tak terkompresi
    this.id = idOf(this.pub);
  }
  get privB64() { return this.ecdh.getPrivateKey().toString("base64"); }
  dh(peerPub) { return this.ecdh.computeSecret(peerPub); }
}

function validPub(b) {
  if (!Buffer.isBuffer(b) || b.length !== 65 || b[0] !== 4) return false;
  try { crypto.createPublicKey({ key: Buffer.concat([SPKI_P256, b]), format: "der", type: "spki" }); return true; } catch { return false; }
}

// Pembaca frame dari socket, dengan penahan (pause) kalau antrean penuh
class Framer {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.q = [];
    this.waiter = null;
    this.err = null;
    sock.on("data", (d) => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this.pump(); });
    sock.on("end", () => this.fail(new Error("Sambungan ditutup perangkat lain")));
    sock.on("close", () => this.fail(new Error("Sambungan terputus")));
    sock.on("error", (e) => this.fail(e));
  }
  pump() {
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (n > MAX_FRAME) return this.fail(new Error("Frame terlalu besar"));
      if (this.buf.length < 4 + n) break;
      this.q.push(this.buf.subarray(4, 4 + n));
      this.buf = this.buf.subarray(4 + n);
    }
    if (this.q.length > 16) this.sock.pause();
    this.wake();
  }
  wake() {
    if (!this.waiter) return;
    const w = this.waiter;
    if (this.q.length) { this.waiter = null; clearTimeout(w.t); w.res(this.take()); }
    else if (this.err) { this.waiter = null; clearTimeout(w.t); w.rej(this.err); }
  }
  take() {
    const f = this.q.shift();
    if (this.q.length < 4 && this.sock.isPaused()) this.sock.resume();
    return Buffer.from(f);
  }
  fail(e) { if (!this.err) this.err = e; this.wake(); }
  next(ms = 30000) {
    if (this.q.length) return Promise.resolve(this.take());
    if (this.err) return Promise.reject(this.err);
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiter = null; rej(new Error("Perangkat lain tidak menjawab")); }, ms);
      this.waiter = { res, rej, t };
    });
  }
}

function writeRaw(sock, body) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return new Promise((res, rej) => {
    if (sock.destroyed) return rej(new Error("Sambungan terputus"));
    const ok = sock.write(Buffer.concat([head, body]), (e) => { if (e) rej(e); });
    if (ok) res(); else sock.once("drain", res);
  });
}

class Session {
  constructor(sock, framer, kSend, kRecv) {
    this.sock = sock; this.framer = framer; this.kSend = kSend; this.kRecv = kRecv;
    this.nSend = 0n; this.nRecv = 0n;
  }
  static nonce(n) { const b = Buffer.alloc(12); b.writeBigUInt64BE(n, 4); return b; }
  async send(type, payload) {
    const c = crypto.createCipheriv("aes-256-gcm", this.kSend, Session.nonce(this.nSend++));
    const body = Buffer.concat([c.update(Buffer.from([type])), c.update(payload), c.final(), c.getAuthTag()]);
    await writeRaw(this.sock, body);
  }
  sendJson(o) { return this.send(T_JSON, Buffer.from(JSON.stringify(o), "utf8")); }
  async recv(ms) {
    const f = await this.framer.next(ms);
    if (f.length < 17) throw new Error("Frame rusak");
    const d = crypto.createDecipheriv("aes-256-gcm", this.kRecv, Session.nonce(this.nRecv++));
    d.setAuthTag(f.subarray(f.length - 16));
    let p;
    try { p = Buffer.concat([d.update(f.subarray(0, f.length - 16)), d.final()]); }
    catch { throw new Error("Data tidak bisa dibuka (kunci tidak cocok atau diubah di jalan)"); }
    const type = p[0], body = p.subarray(1);
    if (type === T_JSON) { let j; try { j = JSON.parse(body.toString("utf8")); } catch { throw new Error("Pesan rusak"); } return { type, json: j }; }
    return { type, data: body };
  }
  close() { try { this.sock.end(); } catch {} setTimeout(() => { try { this.sock.destroy(); } catch {} }, 2000); }
}

// Jabat tangan. role: "c" (yang menyambung) atau "s" (yang menerima).
async function handshake(sock, me, info, role) {
  const framer = new Framer(sock);
  const eph = crypto.createECDH("prime256v1");
  eph.generateKeys();
  const mine = Buffer.from(JSON.stringify({ rk: 1, id: me.id, name: info.name, type: info.type, port: info.port || 0, pub: me.pub.toString("base64"), eph: eph.getPublicKey().toString("base64") }), "utf8");
  let theirs;
  if (role === "c") { await writeRaw(sock, mine); theirs = await framer.next(15000); }
  else { theirs = await framer.next(15000); await writeRaw(sock, mine); }
  let h;
  try { h = JSON.parse(theirs.toString("utf8")); } catch { throw new Error("Bukan perangkat Ruang Kirim"); }
  if (!h || h.rk !== 1) throw new Error("Versi Ruang Kirim berbeda");
  const pub = Buffer.from(String(h.pub || ""), "base64"), epub = Buffer.from(String(h.eph || ""), "base64");
  if (!validPub(pub) || !validPub(epub)) throw new Error("Kunci perangkat lain tidak sah");
  if (idOf(pub) !== h.id) throw new Error("Identitas perangkat lain tidak cocok dengan kuncinya");
  if (h.id === me.id) throw new Error("Tidak bisa menyambung ke diri sendiri");
  const [hc, hs] = role === "c" ? [mine, theirs] : [theirs, mine];
  const len = (b) => { const x = Buffer.alloc(4); x.writeUInt32BE(b.length, 0); return x; };
  const salt = sha256(len(hc), hc, len(hs), hs);
  const ikm = Buffer.concat([eph.computeSecret(epub), me.dh(pub)]);
  const c2s = hkdf(ikm, salt, "rk1 c2s", 32), s2c = hkdf(ikm, salt, "rk1 s2c", 32);
  const code = String(hkdf(ikm, salt, "rk1 kode", 4).readUInt32BE(0) % 1000000).padStart(6, "0");
  const sess = role === "c" ? new Session(sock, framer, c2s, s2c) : new Session(sock, framer, s2c, c2s);
  const peer = { id: h.id, name: String(h.name || "Perangkat").slice(0, 60), type: h.type === "hp" ? "hp" : "pc", port: +h.port || 0, pub: pub.toString("base64") };
  return { sess, peer, code };
}

module.exports = { Identity, Session, handshake, idOf, fmtId, validPub, sha256, CHUNK, T_JSON, T_DATA, MAX_FRAME };
