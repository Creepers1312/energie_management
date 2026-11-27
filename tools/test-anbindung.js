// Prüft die Adapter der Online-Anbindung gegen nachgebaute Geräte (ohne Datenbank):
// Modbus TCP (Holding/Input, Datentypen, Wortreihenfolge, Fehlercode), M-Bus über TCP-Gateway (RSP_UD mit
// Volumen- und Energie-Datensatz), REST/JSON (Pfad, Basic-Anmeldung). Aufruf: node tools/test-anbindung.js
// (im Ordner backend müssen die Pakete installiert sein: cd backend && npm ci)
const net = require("net");
const http = require("http");
const assert = require("assert");
const path = require("path");
const m = require(path.join(__dirname, "../backend/src/metering"));
const R = m._readers;

function listen(server) { return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))); }

// ---------- Modbus-TCP-Gerät: Holding-Register 100.. = 1234567 (uint32), 200.. = 42,5 (float32, Wörter getauscht)
const regs = {};
const put32 = (a, buf) => { regs[a] = buf.readUInt16BE(0); regs[a + 1] = buf.readUInt16BE(2); };
{ const b = Buffer.alloc(4); b.writeUInt32BE(1234567); put32(100, b); }
{ const b = Buffer.alloc(4); b.writeFloatBE(42.5); regs[200] = b.readUInt16BE(2); regs[201] = b.readUInt16BE(0); }
regs[300] = 0xfffe;   // int16 = -2
const modbus = net.createServer((s) => s.on("data", (d) => {
  const tid = d.readUInt16BE(0), unit = d[6], fn = d[7], addr = d.readUInt16BE(8), qty = d.readUInt16BE(10);
  let pdu;
  if (addr === 999) pdu = Buffer.from([fn | 0x80, 2]);
  else { pdu = Buffer.alloc(2 + qty * 2); pdu[0] = fn; pdu[1] = qty * 2; for (let i = 0; i < qty; i++) pdu.writeUInt16BE(regs[addr + i] || 0, 2 + i * 2); }
  const h = Buffer.alloc(7); h.writeUInt16BE(tid, 0); h.writeUInt16BE(0, 2); h.writeUInt16BE(pdu.length + 1, 4); h[6] = unit;
  s.write(Buffer.concat([h, pdu]));
}));

// ---------- M-Bus-Gateway (transparent): SND_NKE → E5, REQ_UD2 → RSP_UD
function rspUd(addr) {
  const head = [0x78, 0x56, 0x34, 0x12, 0x24, 0x40, 0x01, 0x07, 0x55, 0x00, 0x00, 0x00];   // Ident, Hersteller, Vers., Medium Wasser
  const recs = [0x04, 0x13, ...[12345678].flatMap((v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]),  // 12345,678 m³
    0x0c, 0x06, 0x56, 0x34, 0x12, 0x00];                                                                                   // BCD 123456 kWh
  const body = [0x08, addr, 0x72, ...head, ...recs];
  const cs = body.reduce((a, b) => (a + b) & 255, 0);
  return Buffer.from([0x68, body.length, body.length, 0x68, ...body, cs, 0x16]);
}
const mbus = net.createServer((s) => s.on("data", (d) => {
  if (d[0] === 0x10 && d[1] === 0x40) s.write(Buffer.from([0xe5]));
  if (d[0] === 0x10 && d[1] === 0x7b) s.write(rspUd(d[2]));
}));

// ---------- REST
const rest = http.createServer((req, res) => {
  if (req.headers.authorization !== "Basic " + Buffer.from("leser:geheim").toString("base64")) { res.writeHead(401); return res.end(); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: { meters: [{ id: "W1", reading: "5.432,1" }] } }));
});

(async () => {
  const pm = await listen(modbus), pb = await listen(mbus), ph = await listen(rest);
  const c = { host: "127.0.0.1", port: pm, unitId: 1, timeoutSec: 3 };
  assert.strictEqual(await R.modbus(c, { register: 100, dtype: "uint32", fn: "holding" }), 1234567);
  assert.strictEqual(await R.modbus(c, { register: 40101, dtype: "uint32" }), 1234567, "Schreibweise 40101");
  assert.strictEqual(await R.modbus(c, { register: 200, dtype: "float32", order: "le" }), 42.5, "float32 mit getauschten Wörtern");
  assert.strictEqual(await R.modbus(c, { register: 300, dtype: "int16" }), -2);
  await assert.rejects(R.modbus(c, { register: 999, dtype: "uint16" }), /Registeradresse ungültig/);
  await assert.rejects(R.modbus({ host: "127.0.0.1", port: 1, timeoutSec: 1 }, { register: 1 }), /Modbus/);
  console.log("✓ Modbus TCP");
  const mb = { host: "127.0.0.1", port: pb, timeoutSec: 3 };
  assert.strictEqual(await R.mbus(mb, { mbusAddr: 5 }), 12345.678, "erster Zählerstand (Volumen)");
  assert.strictEqual(await R.mbus(mb, { mbusAddr: 5, mbusRecord: 1 }), 123456, "Datensatz 1 (Energie, BCD)");
  console.log("✓ M-Bus über TCP-Gateway");
  const passEnc = require(path.join(__dirname, "../backend/src/secrets")).encrypt("meter-conn", "geheim");
  const hc = { url: "http://127.0.0.1:" + ph + "/api", authType: "basic", user: "leser", passEnc, timeoutSec: 3 };
  assert.strictEqual(await R.http(hc, { path: "zaehler", jsonPath: "data.meters.0.reading" }), 5432.1);
  await assert.rejects(R.http(Object.assign({}, hc, { user: "x" }), { path: "zaehler", jsonPath: "a" }), /401/);
  console.log("✓ REST / JSON");
  assert.strictEqual(m._jsonPick({ a: [{ b: "1,5" }] }, "a.0.b"), 1.5);
  console.log("Online-Anbindung: alle Prüfungen bestanden");
  [modbus, mbus, rest].forEach((s) => s.close());
  process.exit(0);
})().catch((e) => { console.error("FEHLER:", e.message); process.exit(1); });
