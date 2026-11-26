"use strict";
/* ============================================================================
   Online-Anbindung der Zähler
   ---------------------------------------------------------------------------
   Verbindungen (Gateways, Broker, Portale) liegen in meta „meter_connections“ — Passwörter und Push-Schlüssel
   AES-256-GCM-verschlüsselt (secrets.js). Was je Zähler abgefragt wird, steht im Dokument energy unter
   meters[].source (keine Geheimnisse): { enabled, conn, interval, scale, … je Art }.
   Der Abfrage-Dienst prüft alle 30 s, welche Zähler fällig sind (Intervall in Minuten), liest den Zählerstand über
   den Adapter der Verbindung und speichert ihn in meter_values (Zählereinheit vor Messfaktor, wie bei der Ablesung).
   Adapter: modbus (Modbus TCP), mbus (M-Bus über transparentes TCP-Gateway), mqtt, http (REST/JSON),
   push (Logger senden per HTTP an /api/ingest/<id>), file (CSV-Dateien im Import-Ordner), sim (Simulator).
   ========================================================================== */
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const config = require("./config");
const secrets = require("./secrets");
const { HttpError } = require("./http");

const META_KEY = "meter_connections";
const TYPES = ["modbus", "mbus", "mqtt", "http", "push", "file", "sim"];
const TYPE_LABEL = { modbus: "Modbus TCP", mbus: "M-Bus (TCP-Gateway)", mqtt: "MQTT", http: "REST / JSON", push: "HTTP-Push", file: "CSV-Ordner", sim: "Simulator" };
const TICK_MS = 30000;

/* ---------- Hilfen ---------- */
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v, dflt, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).trim().replace(/\s/g, "");
  if (!s) return null;
  if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
// Wert aus JSON über einen Pfad wie „data.meters.0.value“ (leer = ganzes Objekt muss eine Zahl sein)
function jsonPick(obj, p) {
  if (!p) return num(obj);
  let cur = obj;
  for (const part of String(p).split(".").filter(Boolean)) {
    if (cur == null) return null;
    cur = cur[/^\d+$/.test(part) && Array.isArray(cur) ? +part : part];
  }
  return num(cur);
}
// Netzwerkfehler verständlich auf Deutsch
function netMsg(e, where) {
  const code = e && e.code;
  const t = { ECONNREFUSED: "Verbindung abgelehnt (läuft das Gerät, stimmt der Port?)", ETIMEDOUT: "Zeitüberschreitung beim Verbinden",
    EHOSTUNREACH: "Gerät im Netz nicht erreichbar", ENETUNREACH: "Netz nicht erreichbar", ENOTFOUND: "Adresse nicht gefunden (Name falsch?)",
    EAI_AGAIN: "Adresse konnte nicht aufgelöst werden", ECONNRESET: "Verbindung vom Gerät getrennt" }[code];
  return (where ? where + ": " : "") + (t || (e && e.message) || "unbekannter Fehler");
}
const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(what + ": keine Antwort nach " + Math.round(ms / 1000) + " s")), ms));

/* ---------- Verbindungen ---------- */
function cleanConn(c, old) {
  const type = TYPES.includes(c.type) ? c.type : "sim";
  const o = {
    id: /^[a-z0-9-]{4,40}$/.test(String(c.id || "")) ? c.id : "c" + crypto.randomBytes(5).toString("hex"),
    name: str(c.name, 80) || TYPE_LABEL[type], type, enabled: c.enabled !== false,
    interval: int(c.interval, 15, 1, 1440),            // Minuten
    timeoutSec: int(c.timeoutSec, 5, 1, 60),
    host: str(c.host, 200), port: int(c.port, type === "mbus" ? 10001 : type === "modbus" ? 502 : 0, 0, 65535),
    unitId: int(c.unitId, 1, 0, 255),
    url: str(c.url, 500),                              // http: Basis-URL; mqtt: Broker (mqtt://host:1883)
    authType: ["none", "basic", "bearer", "header"].includes(c.authType) ? c.authType : "none",
    authHeader: str(c.authHeader, 60),
    user: str(c.user, 120),
    topicPrefix: str(c.topicPrefix, 200),
    folder: str(c.folder, 80).replace(/[^A-Za-z0-9_-]/g, ""),
    note: str(c.note, 300)
  };
  // Geheimnisse: nur ändern, wenn mitgeschickt; sonst den gespeicherten (verschlüsselten) Wert behalten
  o.passEnc = old && old.passEnc ? old.passEnc : null;
  if (typeof c.password === "string" && c.password) o.passEnc = secrets.encrypt("meter-conn", c.password);
  if (c.clearPassword) o.passEnc = null;
  o.tokenEnc = old && old.tokenEnc ? old.tokenEnc : null;
  if (type === "push" && (!o.tokenEnc || c.newToken)) o.tokenEnc = secrets.encrypt("meter-push", crypto.randomBytes(24).toString("base64url"));
  return o;
}
async function getRaw() {
  const v = await db.getMeta(META_KEY);
  return Array.isArray(v) ? v : [];
}
// Für die Oberfläche: nie das Passwort; den Push-Schlüssel nur für die Administration
function toClient(c, admin) {
  const o = Object.assign({}, c);
  delete o.passEnc; delete o.tokenEnc;
  o.hasPassword = !!c.passEnc;
  o.label = TYPE_LABEL[c.type];
  if (c.type === "push") o.token = admin ? secrets.decrypt("meter-push", c.tokenEnc) : null;
  const st = connStatus[c.id];
  if (st) o.status = st;
  return o;
}
async function listConnections(admin) { return (await getRaw()).map((c) => toClient(c, admin)); }
async function saveConnections(list) {
  if (!Array.isArray(list) || list.length > 200) throw new HttpError(400, "Ungültige Liste der Verbindungen.");
  const old = await getRaw();
  const ids = new Set();
  const out = list.map((c) => {
    const o = cleanConn(c || {}, old.find((x) => x.id === (c && c.id)));
    if (ids.has(o.id)) o.id = "c" + crypto.randomBytes(5).toString("hex");
    ids.add(o.id);
    return o;
  });
  await db.setMeta(META_KEY, out);
  restartMqtt(out);
  return out;
}
function password(c) { return c.passEnc ? secrets.decrypt("meter-conn", c.passEnc) : ""; }

/* ---------- Modbus TCP ---------- */
let modbusTx = 1;
function modbusRead(c, fn, address, count) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: c.host, port: c.port || 502 });
    const tid = (modbusTx = (modbusTx % 65535) + 1);
    let buf = Buffer.alloc(0), done = false;
    const finish = (err, val) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(val); };
    sock.setTimeout((c.timeoutSec || 5) * 1000, () => finish(new Error("Modbus: keine Antwort von " + c.host)));
    sock.on("error", (e) => finish(new Error(netMsg(e, "Modbus"))));
    sock.on("connect", () => {
      const req = Buffer.alloc(12);
      req.writeUInt16BE(tid, 0); req.writeUInt16BE(0, 2); req.writeUInt16BE(6, 4);
      req.writeUInt8(c.unit != null ? c.unit : c.unitId, 6); req.writeUInt8(fn, 7);
      req.writeUInt16BE(address, 8); req.writeUInt16BE(count, 10);
      sock.write(req);
    });
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return;
      const len = buf.readUInt16BE(4);
      if (buf.length < 6 + len) return;
      const f = buf.readUInt8(7);
      if (f & 0x80) {
        const code = buf.readUInt8(8);
        const why = { 1: "Funktion nicht unterstützt", 2: "Registeradresse ungültig", 3: "Wert ungültig", 4: "Gerätefehler", 10: "Gateway: Pfad nicht verfügbar", 11: "Gateway: Gerät antwortet nicht" }[code] || "Fehlercode " + code;
        return finish(new Error("Modbus: " + why));
      }
      const bytes = buf.readUInt8(8);
      finish(null, buf.subarray(9, 9 + bytes));
    });
  });
}
const DTYPE_REGS = { uint16: 1, int16: 1, uint32: 2, int32: 2, float32: 2, uint64: 4, int64: 4, float64: 4 };
function decodeRegs(data, dtype, order) {
  const regs = [];
  for (let i = 0; i + 1 < data.length; i += 2) regs.push(data.subarray(i, i + 2));
  if (order === "le") regs.reverse();               // Wortreihenfolge getauscht (niederwertiges Wort zuerst)
  const b = Buffer.concat(regs);
  switch (dtype) {
    case "uint16": return b.readUInt16BE(0);
    case "int16": return b.readInt16BE(0);
    case "uint32": return b.readUInt32BE(0);
    case "int32": return b.readInt32BE(0);
    case "float32": return b.readFloatBE(0);
    case "uint64": return Number(b.readBigUInt64BE(0));
    case "int64": return Number(b.readBigInt64BE(0));
    case "float64": return b.readDoubleBE(0);
    default: throw new Error("Unbekannter Datentyp " + dtype);
  }
}
// Registeradresse: 0-basiert; Schreibweise 40001… (Holding) bzw. 30001… (Input) wird umgerechnet
function modbusAddress(src) {
  let a = int(src.register, 0, 0, 465535), fn = src.fn === "input" ? 4 : 3;
  if (a >= 400001) { a -= 400001; fn = 3; } else if (a >= 300001) { a -= 300001; fn = 4; }
  else if (a >= 40001 && a <= 49999) { a -= 40001; fn = 3; } else if (a >= 30001 && a <= 39999) { a -= 30001; fn = 4; }
  return { address: a, fn };
}
async function readModbus(c, src) {
  if (!c.host) throw new Error("Modbus: keine Adresse des Geräts/Gateways eingetragen");
  const dtype = DTYPE_REGS[src.dtype] ? src.dtype : "uint32";
  const { address, fn } = modbusAddress(src);
  const unit = src.unit !== undefined && src.unit !== "" && src.unit !== null ? int(src.unit, c.unitId, 0, 255) : c.unitId;
  const data = await modbusRead(Object.assign({}, c, { unit }), fn, address, DTYPE_REGS[dtype]);
  return decodeRegs(data, dtype, src.order === "le" ? "le" : "be");
}

/* ---------- M-Bus über transparentes TCP-Gateway (EN 13757-3) ---------- */
function mbusShort(c, a) { return Buffer.from([0x10, c, a, (c + a) & 0xff, 0x16]); }
function mbusExchange(c, frame, expectLong) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: c.host, port: c.port || 10001 });
    let buf = Buffer.alloc(0), done = false;
    const finish = (err, val) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(val); };
    sock.setTimeout((c.timeoutSec || 5) * 1000, () => finish(new Error("M-Bus: keine Antwort vom Zähler")));
    sock.on("error", (e) => finish(new Error(netMsg(e, "M-Bus"))));
    sock.on("connect", () => sock.write(frame));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!expectLong) { if (buf.indexOf(0xe5) >= 0) finish(null, buf); return; }
      const s = buf.indexOf(0x68);
      if (s < 0 || buf.length < s + 4) return;
      const L = buf[s + 1];
      if (buf.length < s + L + 6) return;
      const fr = buf.subarray(s, s + L + 6);
      if (fr[3] !== 0x68 || fr[L + 5] !== 0x16) return finish(new Error("M-Bus: ungültiger Rahmen"));
      let cs = 0;
      for (let i = 4; i < 4 + L; i++) cs = (cs + fr[i]) & 0xff;
      if (cs !== fr[L + 4]) return finish(new Error("M-Bus: Prüfsumme falsch"));
      finish(null, fr);
    });
  });
}
function bcd(bytes) {
  let v = 0;
  for (let i = bytes.length - 1; i >= 0; i--) { v = v * 100 + (bytes[i] >> 4) * 10 + (bytes[i] & 0x0f); }
  return v;
}
// Datensätze eines RSP_UD-Rahmens (CI 0x72) lesen: [{ index, unit, value, storage, func }]
function mbusRecords(frame) {
  const L = frame[1], ci = frame[6];
  if (ci !== 0x72 && ci !== 0x76) throw new Error("M-Bus: Antwort ohne Datenblock (CI " + ci.toString(16) + ")");
  let i = 7 + 12;                       // fester Kopf: Ident, Hersteller, Version, Medium, Zugriffsnr., Status, Signatur
  const end = 4 + L, out = [];
  while (i < end) {
    let dif = frame[i++];
    if (dif === 0x0f || dif === 0x1f) break;           // herstellerspezifisch
    if (dif === 0x2f) continue;                        // Füllbyte
    let storage = (dif >> 6) & 1, func = (dif >> 4) & 3, dife = dif;
    let sh = 1;
    while (dife & 0x80) { dife = frame[i++]; storage |= (dife & 0x0f) << sh; sh += 4; }
    let vif = frame[i++], vifPrim = vif & 0x7f, vifeHad = vif & 0x80;
    while (vifeHad) { const ve = frame[i++]; vifeHad = ve & 0x80; }
    const len = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 4, 6: 6, 7: 8, 9: 1, 10: 2, 11: 3, 12: 4, 14: 6 }[dif & 0x0f];
    if (len === undefined) break;                      // variable Länge u. ä. — hier nicht gebraucht
    const raw = frame.subarray(i, i + len); i += len;
    const code = dif & 0x0f;
    let v;
    if (code === 5) v = raw.readFloatLE(0);
    else if (code >= 9) v = bcd(raw);
    else { v = 0; for (let k = len - 1; k >= 0; k--) v = v * 256 + raw[k]; if (len && raw[len - 1] & 0x80 && code !== 0) v -= Math.pow(256, len); }
    let unit = null, val = null;
    if ((vifPrim & 0x78) === 0x00) { unit = "kWh"; val = v * Math.pow(10, (vifPrim & 7) - 3) / 1000; }          // Energie Wh
    else if ((vifPrim & 0x78) === 0x08) { unit = "kWh"; val = v * Math.pow(10, vifPrim & 7) / 3600000; }     // Energie J → kWh
    else if ((vifPrim & 0x78) === 0x10) { unit = "m³"; val = v * Math.pow(10, (vifPrim & 7) - 6); }          // Volumen
    out.push({ index: out.length, unit, value: val, raw: v, storage, func, vif });
  }
  return out;
}
async function readMbus(c, src) {
  if (!c.host) throw new Error("M-Bus: keine Adresse des Gateways eingetragen");
  const a = int(src.mbusAddr, 1, 0, 254);
  await mbusExchange(c, mbusShort(0x40, a), false).catch(() => null);  // SND_NKE (Antwort optional)
  const fr = await mbusExchange(c, mbusShort(0x7b, a), true);          // REQ_UD2
  const recs = mbusRecords(fr);
  let rec;
  if (src.mbusRecord !== undefined && src.mbusRecord !== "" && src.mbusRecord !== "auto") rec = recs[int(src.mbusRecord, 0, 0, 999)];
  else rec = recs.find((r) => r.unit && r.storage === 0 && r.func === 0);
  if (!rec) throw new Error("M-Bus: kein Zählerstand (Energie/Volumen) in der Antwort gefunden");
  if (rec.value == null) throw new Error("M-Bus: Datensatz " + rec.index + " ist kein Zählerstand");
  return rec.value;
}

/* ---------- REST / JSON ---------- */
async function readHttp(c, src) {
  let url = str(src.path, 500);
  if (!/^https?:\/\//i.test(url)) url = (c.url || "").replace(/\/+$/, "") + (url ? "/" + url.replace(/^\/+/, "") : "");
  if (!/^https?:\/\//i.test(url)) throw new Error("REST: keine gültige Adresse (http:// oder https://)");
  const headers = { Accept: "application/json, text/plain" };
  const pw = password(c);
  if (c.authType === "basic") headers.Authorization = "Basic " + Buffer.from(c.user + ":" + pw).toString("base64");
  if (c.authType === "bearer") headers.Authorization = "Bearer " + pw;
  if (c.authType === "header" && c.authHeader) headers[c.authHeader] = pw;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), (c.timeoutSec || 5) * 1000);
  let res;
  try { res = await fetch(url, { headers, signal: ctrl.signal }); }
  catch (e) { throw new Error(e.name === "AbortError" ? "REST: keine Antwort" : netMsg(e.cause || e, "REST")); }
  finally { clearTimeout(t); }
  if (!res.ok) throw new Error("REST: Antwort " + res.status);
  const text = (await res.text()).slice(0, 2000000);
  let v;
  try { v = jsonPick(JSON.parse(text), src.jsonPath); } catch (e) { v = src.jsonPath ? null : num(text); }
  if (v == null) throw new Error("REST: kein Zahlenwert unter „" + (src.jsonPath || "(ganze Antwort)") + "“");
  return v;
}

/* ---------- MQTT: Abonnements halten die jeweils letzte Nachricht je Thema ---------- */
let mqttLib = null;
const mqttClients = {};    // conn.id → { client, last: { topic: { value, at } } }
function mqttTopic(c, src) { return [c.topicPrefix, src.topic].filter(Boolean).join("/").replace(/\/+/g, "/"); }
async function restartMqtt(conns) {
  Object.keys(mqttClients).forEach((id) => { try { mqttClients[id].client.end(true); } catch (e) { /* egal */ } delete mqttClients[id]; });
  const list = (conns || await getRaw()).filter((c) => c.type === "mqtt" && c.enabled && c.url);
  if (!list.length) return;
  if (!mqttLib) { try { mqttLib = require("mqtt"); } catch (e) { console.warn("[metering] MQTT-Bibliothek fehlt"); return; } }
  const meters = await meterSources();
  list.forEach((c) => {
    const topics = meters.filter((m) => m.source.conn === c.id).map((m) => mqttTopic(c, m.source)).filter(Boolean);
    const client = mqttLib.connect(c.url, { username: c.user || undefined, password: password(c) || undefined, reconnectPeriod: 10000, connectTimeout: (c.timeoutSec || 5) * 1000, clientId: "energie-" + crypto.randomBytes(4).toString("hex") });
    const entry = { client, last: {} };
    mqttClients[c.id] = entry;
    client.on("connect", () => { if (topics.length) client.subscribe(topics); setConnStatus(c.id, null); });
    client.on("error", (e) => setConnStatus(c.id, "MQTT: " + e.message));
    client.on("message", (topic, payload) => { entry.last[topic] = { payload: payload.toString("utf8").slice(0, 100000), at: Date.now() }; });
  });
}
async function readMqtt(c, src) {
  const e = mqttClients[c.id];
  if (!e) throw new Error("MQTT: keine Verbindung zum Broker");
  const topic = mqttTopic(c, src), m = e.last[topic];
  if (!m) throw new Error("MQTT: noch keine Nachricht auf „" + topic + "“");
  if (Date.now() - m.at > Math.max(3, (src.interval || c.interval) * 3) * 60000) throw new Error("MQTT: letzte Nachricht ist veraltet");
  let v;
  try { v = jsonPick(JSON.parse(m.payload), src.jsonPath); } catch (err) { v = src.jsonPath ? null : num(m.payload); }
  if (v == null) throw new Error("MQTT: kein Zahlenwert in der Nachricht");
  return v;
}

/* ---------- Simulator ---------- */
async function readSim(c, src, meter) {
  const r = await db.pool.query("SELECT value, ts FROM meter_values WHERE meter = $1 ORDER BY ts DESC LIMIT 1", [meter.id]);
  const perHour = num(src.simRate) != null ? num(src.simRate) : 10;
  if (!r.rows.length) return num(src.simStart) != null ? num(src.simStart) : (meter.lastReading != null ? meter.lastReading : 0);
  const hours = Math.max(0, (Date.now() - new Date(r.rows[0].ts).getTime()) / 3600000);
  return Math.round((r.rows[0].value + perHour * hours * (0.75 + Math.random() * 0.5)) * 1000) / 1000;
}

const READERS = { modbus: readModbus, mbus: readMbus, http: readHttp, mqtt: readMqtt, sim: readSim };

/* ---------- Zähler mit Online-Quelle aus dem Dokument energy ---------- */
async function meterSources() {
  const r = await db.pool.query("SELECT value FROM documents WHERE name = 'energy'");
  const doc = r.rows[0] && r.rows[0].value;
  const meters = doc && Array.isArray(doc.meters) ? doc.meters : [];
  const readings = doc && Array.isArray(doc.readings) ? doc.readings : [];
  return meters.filter((m) => m && !m.removed && m.source && m.source.enabled && m.source.conn).map((m) => {
    const last = readings.filter((x) => x && x.meter === m.id && !x.deleted).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    return { id: m.id, no: m.no, source: m.source, lastReading: last ? num(last.value) : null };
  });
}

/* ---------- Speichern und Status ---------- */
const connStatus = {};
function setConnStatus(id, error) { connStatus[id] = { error: error || null, at: new Date().toISOString() }; }
async function storeValue(meterId, value, ts, source) {
  const v = num(value);
  if (v == null) throw new Error("kein Zahlenwert");
  const t = ts ? new Date(ts) : new Date();
  if (isNaN(t.getTime())) throw new Error("ungültiger Zeitpunkt");
  await db.pool.query(`INSERT INTO meter_values (meter, ts, value, source) VALUES ($1, $2, $3, $4)
    ON CONFLICT (meter, ts) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`, [meterId, t, v, source || ""]);
  await db.pool.query(`INSERT INTO meter_status (meter, ok_at, value, error, error_at, updated_at) VALUES ($1, $2, $3, NULL, NULL, now())
    ON CONFLICT (meter) DO UPDATE SET ok_at = GREATEST(meter_status.ok_at, EXCLUDED.ok_at),
      value = CASE WHEN meter_status.ok_at IS NULL OR EXCLUDED.ok_at >= meter_status.ok_at THEN EXCLUDED.value ELSE meter_status.value END,
      error = NULL, updated_at = now()`, [meterId, t, v]);
  return { value: v, ts: t.toISOString() };
}
async function storeError(meterId, msg) {
  await db.pool.query(`INSERT INTO meter_status (meter, error, error_at, updated_at) VALUES ($1, $2, now(), now())
    ON CONFLICT (meter) DO UPDATE SET error = EXCLUDED.error, error_at = now(), updated_at = now()`, [meterId, String(msg).slice(0, 300)]);
}
function scaled(v, src) { const f = num(src.scale); return f == null || f === 0 ? v : Math.round(v * f * 1e6) / 1e6; }

// Einen Zähler sofort abfragen (Abfrage-Dienst, „Jetzt abfragen“, Test)
async function readMeter(m, conns, opts = {}) {
  const c = conns.find((x) => x.id === m.source.conn);
  if (!c) throw new Error("Verbindung nicht gefunden");
  const reader = READERS[c.type];
  if (!reader) throw new Error(TYPE_LABEL[c.type] + " liefert die Werte selbst (keine Abfrage)");
  const raw = await Promise.race([reader(c, m.source, m), timeout(((c.timeoutSec || 5) + 2) * 1000, TYPE_LABEL[c.type])]);
  const v = scaled(raw, m.source);
  if (opts.store === false) return { value: v, raw };
  return storeValue(m.id, v, null, c.type);
}

/* ---------- Abfrage-Dienst ---------- */
const lastPoll = {};
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const conns = await getRaw();
    const meters = await meterSources();
    const now = Date.now();
    for (const m of meters) {
      const c = conns.find((x) => x.id === m.source.conn);
      if (!c || !c.enabled || !READERS[c.type]) continue;
      const every = int(m.source.interval, c.interval, 1, 1440) * 60000;
      if (lastPoll[m.id] && now - lastPoll[m.id] < every) continue;
      lastPoll[m.id] = now;
      try { await readMeter(m, conns); setConnStatus(c.id, null); }
      catch (e) { await storeError(m.id, e.message); setConnStatus(c.id, e.message); }
    }
    await importFiles(conns, meters);
  } catch (e) {
    console.error("[metering] Abfrage fehlgeschlagen:", e.message);
  } finally { running = false; }
}
function startScheduler() {
  restartMqtt().catch((e) => console.warn("[metering] MQTT:", e.message));
  setTimeout(tick, 5000).unref();
  setInterval(tick, TICK_MS).unref();
  // MQTT-Abonnements an geänderte Zähler anpassen (alle 5 min reicht)
  setInterval(() => restartMqtt().catch(() => {}), 5 * 60000).unref();
}

/* ---------- Push (HTTP) und CSV-Ordner: Werte über Kennung zuordnen ---------- */
function keyOf(m) { return String(m.source.key || m.no).trim().toLowerCase(); }
async function ingest(connId, token, body) {
  const conns = await getRaw();
  const c = conns.find((x) => x.id === connId && x.type === "push");
  if (!c || !c.enabled) throw new HttpError(404, "Unbekannte Verbindung.");
  const want = secrets.decrypt("meter-push", c.tokenEnc);
  const a = Buffer.from(String(token || "")), b = Buffer.from(String(want || ""));
  if (!want || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, "Schlüssel ungültig.");
  const list = Array.isArray(body) ? body : Array.isArray(body && body.values) ? body.values : [body];
  if (list.length > 5000) throw new HttpError(413, "Höchstens 5000 Werte je Anfrage.");
  const meters = (await meterSources()).filter((m) => m.source.conn === c.id);
  const res = { stored: 0, unknown: [], errors: [] };
  for (const x of list) {
    const key = String((x && (x.key || x.meter || x.id)) || "").trim().toLowerCase();
    const m = meters.find((mm) => keyOf(mm) === key);
    if (!m) { if (res.unknown.length < 50) res.unknown.push(key); continue; }
    try { await storeValue(m.id, scaled(num(x.value), m.source), x.ts || x.time || null, "push"); res.stored++; }
    catch (e) { if (res.errors.length < 50) res.errors.push(key + ": " + e.message); }
  }
  setConnStatus(c.id, res.errors.length ? res.errors[0] : null);
  return res;
}
// CSV: Kennung; Zeitpunkt; Zählerstand (Überschrift optional, Trennzeichen ; oder ,). Verarbeitete Dateien → verarbeitet/
function parseTs(v) {
  v = String(v || "").trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
async function importFiles(conns, meters) {
  const base = config.importDir;
  for (const c of conns.filter((x) => x.type === "file" && x.enabled)) {
    const dir = path.join(base, c.folder || "");
    let files;
    try { files = (await fs.promises.readdir(dir)).filter((f) => /\.(csv|txt)$/i.test(f)); }
    catch (e) { setConnStatus(c.id, "Ordner " + dir + " nicht lesbar"); continue; }
    const mine = meters.filter((m) => m.source.conn === c.id);
    for (const f of files.slice(0, 50)) {
      const full = path.join(dir, f);
      let text;
      try { text = await fs.promises.readFile(full, "utf8"); } catch (e) { continue; }
      let ok = 0, bad = 0;
      for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
        const cells = line.split(line.indexOf(";") >= 0 ? ";" : ",").map((x) => x.trim().replace(/^"|"$/g, ""));
        if (cells.length < 3) continue;
        const m = mine.find((mm) => keyOf(mm) === cells[0].toLowerCase());
        const ts = parseTs(cells[1]), v = num(cells[2]);
        if (!m || !ts || v == null) { bad++; continue; }
        try { await storeValue(m.id, scaled(v, m.source), ts, "file"); ok++; } catch (e) { bad++; }
      }
      const doneDir = path.join(dir, "verarbeitet");
      try { await fs.promises.mkdir(doneDir, { recursive: true }); await fs.promises.rename(full, path.join(doneDir, f)); }
      catch (e) { setConnStatus(c.id, "Datei " + f + " konnte nicht verschoben werden"); continue; }
      setConnStatus(c.id, ok ? null : "Datei " + f + ": keine passende Zeile (" + bad + " übersprungen)");
    }
  }
}

/* ---------- Abfragen für die Oberfläche ---------- */
// Verlauf eines Zählers, auf höchstens max Punkte verdichtet (je Zeitfenster der höchste Stand)
async function series(meterId, from, to, max) {
  const f = new Date(from), t = new Date(to);
  if (isNaN(f) || isNaN(t) || f >= t) throw new HttpError(400, "Ungültiger Zeitraum.");
  const step = Math.max(60, Math.ceil((t - f) / 1000 / int(max, 500, 10, 5000)));
  const r = await db.pool.query(`SELECT date_bin(make_interval(secs => $4), ts, $2::timestamptz) AS b, max(value) AS v, max(ts) AS last
    FROM meter_values WHERE meter = $1 AND ts >= $2 AND ts <= $3 GROUP BY b ORDER BY b`, [meterId, f, t, step]);
  return r.rows.map((x) => ({ ts: x.last, value: x.v }));
}
// Stand je Zähler zu einem Zeitpunkt (Vorschlag für die Ablesung): linear zwischen den Werten davor und danach,
// sonst der nächste Wert innerhalb von 36 h
async function valuesAt(at) {
  const t = new Date(at);
  if (isNaN(t)) throw new HttpError(400, "Ungültiger Zeitpunkt.");
  const r = await db.pool.query(`SELECT s.meter, a.ts AS ats, a.value AS av, b.ts AS bts, b.value AS bv FROM meter_status s
    LEFT JOIN LATERAL (SELECT ts, value FROM meter_values WHERE meter = s.meter AND ts <= $1 ORDER BY ts DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT ts, value FROM meter_values WHERE meter = s.meter AND ts > $1 ORDER BY ts LIMIT 1) b ON true`, [t]);
  const out = {}, lim = 36 * 3600000;
  r.rows.forEach((x) => {
    const a = x.ats ? { ts: new Date(x.ats), value: x.av } : null, b = x.bts ? { ts: new Date(x.bts), value: x.bv } : null;
    const okA = a && t - a.ts <= lim, okB = b && b.ts - t <= lim;
    if (okA && okB && b.ts > a.ts) {
      const v = a.value + (b.value - a.value) * (t - a.ts) / (b.ts - a.ts);
      out[x.meter] = { value: Math.round(v * 1000) / 1000, ts: t.toISOString(), method: "interpoliert", before: a.ts, after: b.ts };
    } else if (okA || okB) {
      const p = okA && (!okB || t - a.ts <= b.ts - t) ? a : b;
      out[x.meter] = { value: p.value, ts: p.ts.toISOString(), method: "nächster Wert" };
    }
  });
  return out;
}
async function statusList() {
  const r = await db.pool.query("SELECT meter, ok_at, value, error, error_at FROM meter_status");
  const cnt = await db.pool.query("SELECT meter, count(*)::int AS n, min(ts) AS first FROM meter_values GROUP BY meter");
  const by = {};
  cnt.rows.forEach((x) => { by[x.meter] = x; });
  return r.rows.map((x) => ({ meter: x.meter, okAt: x.ok_at, value: x.value, error: x.error && (!x.ok_at || x.error_at > x.ok_at) ? x.error : null,
    errorAt: x.error_at, count: by[x.meter] ? by[x.meter].n : 0, first: by[x.meter] ? by[x.meter].first : null }));
}
// Test aus der Oberfläche: Verbindung (Formularwerte, Passwort ggf. gespeichert) + Quelle eines Zählers, ohne zu speichern
async function test(connInput, source) {
  const old = (await getRaw()).find((x) => x.id === connInput.id);
  const c = cleanConn(connInput || {}, old);
  if (!READERS[c.type]) throw new HttpError(400, TYPE_LABEL[c.type] + " liefert die Werte selbst — testen Sie, indem der Logger Werte sendet bzw. eine Datei ablegt.");
  if (c.type === "mqtt") {
    if (!mqttLib) mqttLib = require("mqtt");
    const topic = mqttTopic(c, source || {});
    return await new Promise((resolve, reject) => {
      const client = mqttLib.connect(c.url, { username: c.user || undefined, password: password(c) || undefined, connectTimeout: c.timeoutSec * 1000, reconnectPeriod: 0 });
      const end = (err, v) => { try { client.end(true); } catch (e) { /* egal */ } err ? reject(err) : resolve(v); };
      const t = setTimeout(() => end(new Error("MQTT: keine Nachricht auf „" + topic + "“ innerhalb von " + (c.timeoutSec + 10) + " s")), (c.timeoutSec + 10) * 1000);
      client.on("error", (e) => { clearTimeout(t); end(new Error("MQTT: " + e.message)); });
      client.on("connect", () => { if (!source || !source.topic) { clearTimeout(t); end(null, { connected: true }); } else client.subscribe(topic); });
      client.on("message", (tp, payload) => {
        clearTimeout(t);
        let v; const s = payload.toString("utf8");
        try { v = jsonPick(JSON.parse(s), source.jsonPath); } catch (e) { v = source.jsonPath ? null : num(s); }
        end(v == null ? new Error("MQTT: kein Zahlenwert in „" + s.slice(0, 80) + "“") : null, { value: scaled(v, source), raw: v });
      });
    });
  }
  if (!source) {
    if (c.type === "modbus" || c.type === "mbus") {
      await new Promise((resolve, reject) => {
        const s = net.connect({ host: c.host, port: c.port });
        s.setTimeout(c.timeoutSec * 1000, () => { s.destroy(); reject(new Error("keine Verbindung zu " + c.host + ":" + c.port)); });
        s.on("error", (e) => reject(new Error(netMsg(e))));
        s.on("connect", () => { s.destroy(); resolve(); });
      });
      return { connected: true };
    }
    throw new HttpError(400, "Für den Test bitte einen Zähler mit Online-Quelle wählen.");
  }
  const raw = await Promise.race([READERS[c.type](c, source, { id: "_test", lastReading: 0 }), timeout((c.timeoutSec + 2) * 1000, TYPE_LABEL[c.type])]);
  return { value: scaled(raw, source), raw };
}
async function pollNow(meterId) {
  const m = (await meterSources()).find((x) => x.id === meterId);
  if (!m) throw new HttpError(400, "Der Zähler hat keine aktive Online-Quelle.");
  const conns = await getRaw(), c = conns.find((x) => x.id === m.source.conn);
  if (c && !READERS[c.type]) throw new HttpError(400, TYPE_LABEL[c.type] + " liefert die Werte selbst — eine Abfrage ist nicht möglich.");
  try { const r = await readMeter(m, conns); lastPoll[m.id] = Date.now(); return r; }
  catch (e) { await storeError(m.id, e.message); throw new HttpError(502, e.message); }
}

module.exports = {
  TYPES, TYPE_LABEL, listConnections, saveConnections, startScheduler, ingest, series, valuesAt, statusList, test, pollNow,
  // für Tests
  _decodeRegs: decodeRegs, _mbusRecords: mbusRecords, _modbusAddress: modbusAddress, _jsonPick: jsonPick, _readers: READERS
};
