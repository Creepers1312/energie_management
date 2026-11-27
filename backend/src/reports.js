"use strict";
// Automatische Berichte per E-Mail (Monats- und Jahresbericht). Grundlage sind ausschließlich die freigegebenen
// Abrechnungen (energy.billing[].snap) — das sind die verbindlichen Werte; der Server muss dafür nichts neu
// berechnen. Ein Monatsbericht geht erst raus, wenn der Monat freigegeben ist (frühestens am eingestellten Tag);
// im Jahresbericht werden nicht freigegebene Monate ausgewiesen. Anhänge wahlweise Excel, PDF und CSV.
// Einstellungen und Versandstatus liegen in meta („report_config“).
const config = require("./config");
const db = require("./db");
const mailer = require("./mailer");
const templates = require("./mailtemplates");
const xlsx = require("./xlsx");
const pdf = require("./pdf");
const { HttpError } = require("./http");

const META_KEY = "report_config";
const MAX_RECIPIENTS = 30;
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const TYPES = [
  { key: "strom", label: "Strom", bill: "kWh" }, { key: "wasser", label: "Wasser", bill: "m³" },
  { key: "gas", label: "Gas", bill: "kWh" }, { key: "druckluft", label: "Druckluft", bill: "Nm³" }
];
const CONTENT = { summary: "Übersicht je Energieart", months: "Monatswerte", cc: "Kostenstellen", dept: "Abteilungen", meters: "Zähler", status: "Abrechnungsstatus" };
const FORMATS = ["xlsx", "pdf", "csv"];
const DEFAULTS = {
  monthly: { enabled: false, day: 5, time: "07:00" },
  yearly: { enabled: false, day: 15, time: "07:00" },
  recipients: [], formats: ["xlsx", "pdf"],
  content: { summary: true, months: true, cc: true, dept: true, meters: false, status: true },
  last: { month: null, year: null }
};

const pad = (n) => String(n).padStart(2, "0");
const round = (v, d = 6) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const monthLabel = (m) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const monthShort = (m) => `${MONTHS[+m.slice(5, 7) - 1].slice(0, 3)} ${m.slice(2, 4)}`;
function nf(v, d = 0) {
  if (v == null || !isFinite(v)) return "–";
  return Number(v).toLocaleString("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
}
const euro = (v) => nf(v, 2) + " €";
function fmtCell(v, numeric, col) {
  if (v == null || v === "") return "";
  if (numeric && typeof v === "number" && col && col.indexOf("%") >= 0) return (v > 0 ? "+" : "") + nf(v, 1);
  if (numeric && typeof v === "number") return nf(v, Math.abs(v) < 100 && v % 1 ? 2 : Math.abs(v) >= 1000 || v % 1 === 0 ? 0 : 1);
  return String(v);
}
function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- Werte aus den freigegebenen Abrechnungen ---------- */
function billingOf(energy, month) { return (energy && Array.isArray(energy.billing) ? energy.billing : []).find((b) => b && b.month === month) || null; }
function released(energy, month) { const b = billingOf(energy, month); return b && b.status === "released" && b.snap ? b : null; }
function monthsOf(period) {
  if (period.kind === "year") return Array.from({ length: 12 }, (_, i) => `${period.y}-${pad(i + 1)}`);
  return [`${period.y}-${pad(period.m + 1)}`];
}
function sumRows(energy, months) {
  const out = {};
  months.forEach((mo) => {
    const b = released(energy, mo);
    if (!b) return;
    Object.entries(b.snap.rows || {}).forEach(([k, v]) => {
      const x = out[k] || (out[k] = { qty: 0, cost: 0, base: 0 });
      x.qty = round(x.qty + (v.qty || 0)); x.cost = round(x.cost + (v.cost || 0), 2); x.base = round(x.base + (v.base || 0), 2);
    });
  });
  return out;
}
function sumTotals(energy, months) {
  const out = {};
  TYPES.forEach((t) => { out[t.key] = { measured: 0, allocated: 0, cost: 0 }; });
  months.forEach((mo) => {
    const b = released(energy, mo);
    if (!b) return;
    TYPES.forEach((t) => {
      const x = (b.snap.totals || {})[t.key] || {};
      out[t.key].measured += x.measured || 0; out[t.key].allocated += x.allocated || 0; out[t.key].cost += x.cost || 0;
    });
  });
  TYPES.forEach((t) => { const o = out[t.key]; o.measured = round(o.measured); o.allocated = round(o.allocated); o.cost = round(o.cost, 2); });
  return out;
}
const pct = (a, b) => (b ? round((a - b) / Math.abs(b) * 100, 1) : null);

// Bericht als Abschnitte (wie in der Oberfläche)
function compute(energy, settings, period, content, now = Date.now()) {
  energy = energy || {}; settings = settings || {};
  const months = monthsOf(period), prevMonths = months.map((m) => `${+m.slice(0, 4) - 1}${m.slice(4)}`);
  const rel = months.filter((m) => released(energy, m));
  const ccs = (energy.costCenters || []).slice().sort((a, b) => String(a.no).localeCompare(String(b.no), "de", { numeric: true }));
  const ccName = (id) => { const c = ccs.find((x) => x.id === id); return c ? `${c.no} · ${c.name}` : id; };
  const label = period.kind === "year" ? `Jahr ${period.y}` : monthLabel(months[0]);
  // Vergleich nur über Monate, die in beiden Jahren freigegeben sind (sonst wären die Prozente schief)
  const matched = months.filter((m, i) => released(energy, m) && released(energy, prevMonths[i]));
  const matchedPrev = matched.map((m) => `${+m.slice(0, 4) - 1}${m.slice(4)}`);
  const cmpLabel = period.kind === "year" ? `Vorjahr` : monthLabel(prevMonths[0]);
  const doc = {
    title: (period.kind === "year" ? "Jahresbericht " : "Monatsbericht ") + label,
    label, released: rel.length, months: months.length,
    meta: [["Standort", settings.lineName || ""], ["Zeitraum", label],
      ["Abrechnung", `${rel.length} von ${months.length} ${months.length === 1 ? "Monat" : "Monaten"} freigegeben` + (rel.length < months.length ? " — nicht freigegebene Monate sind nicht enthalten" : "")],
      ["Vergleich", matched.length ? (period.kind === "year" ? `Vorjahr — gleiche Monate, die in beiden Jahren freigegeben sind (${matched.length})` : cmpLabel) : "nicht möglich (Vorjahresmonat nicht freigegeben)"], ["Erstellt", fmtDateTime(now)]],
    sections: []
  };
  const sec = (key, title, cols, num, rows, note) => doc.sections.push({ key, title, cols, num, rows, note: note || "" });
  const cur = sumRows(energy, months), prev = sumRows(energy, matchedPrev), curM = sumRows(energy, matched);
  const t1 = sumTotals(energy, months), t0 = sumTotals(energy, matchedPrev), t1m = sumTotals(energy, matched);
  doc.totals = t1; doc.prevTotals = t0; doc.matchedTotals = t1m;
  const used = TYPES.filter((t) => t1[t.key].measured || t1[t.key].cost || t0[t.key].measured || t0[t.key].cost);
  if (content.summary) {
    sec("summary", "Übersicht je Energieart", ["Energieart", "Einheit", "Verbrauch gesamt", "verrechnet", "nicht verteilt", "Kosten €", "Verbrauch " + cmpLabel, "Veränderung %", "Kosten " + cmpLabel + " €", "Veränderung Kosten %"],
      [0, 0, 1, 1, 1, 1, 1, 1, 1, 1], used.map((t) => {
        const x = t1[t.key], y = t0[t.key], xm = t1m[t.key];
        return [t.label, t.bill, x.measured, x.allocated, round(x.measured - x.allocated), x.cost, matched.length ? y.measured : null, pct(xm.measured, y.measured), matched.length ? y.cost : null, pct(xm.cost, y.cost)];
      }), "Verbrauch gesamt = Hauptzähler. Gas in kWh. Kosten inkl. anteiligem Grundpreis.");
  }
  if (content.months && months.length > 1) {
    sec("months", "Kosten je Monat", ["Monat", "Status"].concat(TYPES.map((t) => t.label + " €"), ["Gesamt €"]), [0, 0, 1, 1, 1, 1, 1], months.map((mo) => {
      const b = released(energy, mo), tot = b ? b.snap.totals || {} : {};
      const vals = TYPES.map((t) => (b ? round((tot[t.key] || {}).cost || 0, 2) : null));
      return [monthLabel(mo), b ? "freigegeben" : "nicht freigegeben"].concat(vals, [b ? round(vals.reduce((a, v) => a + (v || 0), 0), 2) : null]);
    }));
  }
  if (content.cc) {
    const rows = [];
    ccs.forEach((c) => TYPES.forEach((t) => {
      const x = cur[`${c.id}|${t.key}`], y = prev[`${c.id}|${t.key}`];
      if (!x && !y) return;
      const v = x || { qty: 0, cost: 0, base: 0 };
      const vm = curM[`${c.id}|${t.key}`] || { cost: 0 };
      rows.push([c.dept || "", c.no, c.name, t.label, v.qty, t.bill, v.cost, v.base, matched.length ? (y ? y.cost : 0) : null, pct(vm.cost, y ? y.cost : 0)]);
    }));
    sec("cc", "Kostenstellen", ["Abteilung", "Kostenstelle", "Bezeichnung", "Energieart", "Menge", "Einheit", "Kosten €", "davon Grundpreis €", "Kosten " + cmpLabel + " €", "Veränderung %"], [0, 0, 0, 0, 1, 0, 1, 1, 1, 1], rows);
  }
  if (content.dept) {
    const depts = {};
    ccs.forEach((c) => { const d = c.dept || "Ohne Abteilung"; (depts[d] = depts[d] || []).push(c.id); });
    sec("dept", "Kosten je Abteilung", ["Abteilung"].concat(TYPES.map((t) => t.label + " €"), ["Gesamt €", "Gesamt " + cmpLabel + " €", "Veränderung %"]), [0, 1, 1, 1, 1, 1, 1, 1],
      Object.keys(depts).sort((a, b) => a.localeCompare(b, "de")).map((d) => {
        const ids = depts[d];
        const by = TYPES.map((t) => round(ids.reduce((a, id) => a + ((cur[`${id}|${t.key}`] || {}).cost || 0), 0), 2));
        const total = round(by.reduce((a, v) => a + v, 0), 2);
        const ptotal = round(ids.reduce((a, id) => a + TYPES.reduce((b, t) => b + ((prev[`${id}|${t.key}`] || {}).cost || 0), 0), 0), 2);
        const mtotal = round(ids.reduce((a, id) => a + TYPES.reduce((b, t) => b + ((curM[`${id}|${t.key}`] || {}).cost || 0), 0), 0), 2);
        return [d].concat(by, [total, matched.length ? ptotal : null, pct(mtotal, ptotal)]);
      }));
  }
  if (content.meters) {
    const meters = (energy.meters || []).slice().sort((a, b) => TYPES.findIndex((t) => t.key === a.type) - TYPES.findIndex((t) => t.key === b.type) || String(a.no).localeCompare(String(b.no), "de", { numeric: true }));
    const byMonth = months.length > 1;
    const rows = [];
    meters.forEach((m) => {
      const vals = months.map((mo) => { const b = released(energy, mo), x = b && b.snap.meters ? b.snap.meters[m.id] : null; return x && x.status !== "missing" ? x.energy : null; });
      if (!vals.some((v) => v != null)) return;
      const t = TYPES.find((x) => x.key === m.type) || { label: m.type, bill: "" };
      rows.push([m.no, m.name || "", t.label, m.costCenter ? ccName(m.costCenter) : "", t.bill, round(vals.reduce((a, v) => a + (v || 0), 0))].concat(byMonth ? vals : []));
    });
    sec("meters", "Verbrauch je Zähler", ["Zähler", "Bezeichnung", "Energieart", "Kostenstelle", "Einheit", "Summe"].concat(byMonth ? months.map(monthShort) : []), [0, 0, 0, 0, 0, 1].concat(byMonth ? months.map(() => 1) : []), rows);
  }
  if (content.status) {
    sec("status", "Abrechnungsstatus", ["Monat", "Status", "Freigegeben"], [0, 0, 0], months.map((mo) => {
      const b = billingOf(energy, mo);
      const st = !b ? "offen" : b.status === "released" ? "freigegeben" : b.status === "checked" ? "geprüft" : "offen";
      return [monthLabel(mo), st, b && b.released ? `${fmtDateTime(b.released.at)} · ${b.released.by}` : ""];
    }));
  }
  return doc;
}

/* ---------- Mail mit Anhängen ---------- */
function fileBase(doc) {
  return doc.title.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function toCsv(doc) {
  const rows = [[doc.title]].concat(doc.meta);
  doc.sections.forEach((s) => {
    rows.push([], [s.title], s.cols);
    s.rows.forEach((r) => rows.push(r.map((v) => (typeof v === "number" ? String(round(v, 4)).replace(".", ",") : v == null ? "" : v))));
  });
  return "﻿" + rows.map((r) => r.map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
}
function attachmentsFor(doc, formats) {
  const base = fileBase(doc), out = [];
  if (formats.includes("xlsx")) {
    const sheets = [{ name: "Bericht", rows: [[doc.title]].concat(doc.meta), widths: [22, 70] }]
      .concat(doc.sections.map((s) => ({ name: s.title.slice(0, 31), rows: [s.cols].concat(s.rows.map((r) => r.map((v) => (typeof v === "number" ? round(v, 4) : v)))) })));
    out.push({ filename: base + ".xlsx", content: xlsx.write(sheets), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  if (formats.includes("pdf")) out.push({ filename: base + ".pdf", content: pdf.build(Object.assign({ foot: "Energie Management · " + (doc.meta[0][1] || "") }, doc), fmtCell), contentType: "application/pdf" });
  if (formats.includes("csv")) out.push({ filename: base + ".csv", content: Buffer.from(toCsv(doc), "utf8"), contentType: "text/csv; charset=utf-8" });
  return out;
}
function render(doc, { lineName, url }) {
  const C = templates.C, F = templates.FONT, e = templates.esc;
  const sum = doc.sections.find((s) => s.key === "summary");
  const dept = doc.sections.find((s) => s.key === "dept");
  const table = (cols, rows, num) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:8px;margin:0 0 8px;">
    <tr>${cols.map((c, i) => `<td ${num[i] ? 'align="right"' : ""} style="padding:7px 10px;font:600 12px/1.3 ${F};color:${C.muted};background:#f9fafb;">${e(c)}</td>`).join("")}</tr>
    ${rows.map((r) => `<tr>${r.map((v, i) => `<td ${num[i] ? 'align="right"' : ""} style="padding:7px 10px;border-top:1px solid ${C.line};font:13px/1.4 ${F};color:${C.ink};white-space:nowrap;">${e(v)}</td>`).join("")}</tr>`).join("")}
  </table>`;
  const h2 = (t) => `<h2 style="margin:22px 0 10px;font:700 16px/1.3 ${F};color:${C.ink};">${e(t)}</h2>`;
  const totalCost = TYPES.reduce((a, t) => a + (doc.totals[t.key].cost || 0), 0), prevCost = TYPES.reduce((a, t) => a + (doc.prevTotals[t.key].cost || 0), 0);
  const matchedCost = TYPES.reduce((a, t) => a + (doc.matchedTotals[t.key].cost || 0), 0);
  const parts = [
    `<p style="margin:0 0 14px;font:15px/1.6 ${F};color:${C.text};">Bericht für <b>${e(doc.label)}</b> — ${doc.released} von ${doc.months} ${doc.months === 1 ? "Monat" : "Monaten"} freigegeben. Kosten gesamt <b>${e(euro(totalCost))}</b>${prevCost ? ` (Vorjahr ${e(euro(prevCost))}${matchedCost !== totalCost ? " in den vergleichbaren Monaten" : ""}, ${e((pct(matchedCost, prevCost) > 0 ? "+" : "") + nf(pct(matchedCost, prevCost), 1))} %)` : ""}.</p>`
  ];
  if (sum) parts.push(h2("Je Energieart"), table(["Energieart", "Verbrauch", "Kosten", "zum Vorjahr"], sum.rows.map((r) => [r[0], nf(r[2], 0) + " " + r[1], euro(r[5]), r[9] == null ? "–" : (r[9] > 0 ? "+" : "") + nf(r[9], 1) + " %"]), [0, 1, 1, 1]));
  if (dept) parts.push(h2("Kosten je Abteilung"), table(["Abteilung", "Kosten", "zum Vorjahr"], dept.rows.map((r) => [r[0], euro(r[r.length - 3]), r[r.length - 1] == null ? "–" : (r[r.length - 1] > 0 ? "+" : "") + nf(r[r.length - 1], 1) + " %"]), [0, 1, 1]));
  parts.push(`<p style="margin:14px 0 0;font:13px/1.6 ${F};color:${C.muted};">Alle Einzelheiten stehen im Anhang. Grundlage sind die freigegebenen Abrechnungen.</p>`);
  if (url) parts.push(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 14px;"><tr><td bgcolor="${C.accent}" style="border-radius:8px;"><a href="${e(url)}" target="_blank" style="display:inline-block;padding:12px 22px;font:600 14px/1 ${F};color:#ffffff;text-decoration:none;border-radius:8px;">Energie Management öffnen</a></td></tr></table>`);
  const subject = `${doc.title} — ${lineName || "Energie Management"}`;
  const text = [subject, `${doc.released} von ${doc.months} Monaten freigegeben`, `Kosten gesamt: ${euro(totalCost)}`, ""]
    .concat(sum ? sum.rows.map((r) => `${r[0]}: ${nf(r[2], 0)} ${r[1]} · ${euro(r[5])}`) : [], ["", "Einzelheiten im Anhang.", url ? `\n${url}` : ""]).join("\n");
  const html = templates.layout({ title: subject, preheader: `Kosten gesamt ${euro(totalCost)}`, heading: doc.title, body: parts.join("\n"), lineName });
  return { subject, text, html };
}

/* ---------- Einstellungen, Versand, Zeitplan ---------- */
async function getConfig() {
  const cur = (await db.getMeta(META_KEY)) || {};
  return {
    monthly: Object.assign({}, DEFAULTS.monthly, cur.monthly || {}), yearly: Object.assign({}, DEFAULTS.yearly, cur.yearly || {}),
    recipients: Array.isArray(cur.recipients) ? cur.recipients : [], formats: Array.isArray(cur.formats) ? cur.formats : DEFAULTS.formats.slice(),
    content: Object.assign({}, DEFAULTS.content, cur.content || {}), last: Object.assign({ month: null, year: null }, cur.last || {})
  };
}
function cleanPlan(p, name) {
  p = p || {};
  const day = Number(p.day), time = String(p.time || "");
  if (!Number.isInteger(day) || day < 1 || day > 28) throw new HttpError(400, `${name}: Versandtag bitte zwischen 1 und 28 wählen.`);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, `${name}: Uhrzeit bitte als HH:MM angeben.`);
  return { enabled: !!p.enabled, day, time };
}
async function setConfig(body) {
  body = body || {};
  const cur = await getConfig();
  const monthly = cleanPlan(body.monthly, "Monatsbericht"), yearly = cleanPlan(body.yearly, "Jahresbericht");
  if (!Array.isArray(body.recipients)) throw new HttpError(400, "Ungültige Empfängerliste.");
  const recipients = [...new Set(body.recipients.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))];
  if (recipients.length > MAX_RECIPIENTS) throw new HttpError(400, `Höchstens ${MAX_RECIPIENTS} Empfänger.`);
  const bad = recipients.find((x) => !mailer.EMAIL_RE.test(x) || x.length > 200);
  if (bad) throw new HttpError(400, `Ungültige E-Mail-Adresse: ${bad}`);
  if ((monthly.enabled || yearly.enabled) && !recipients.length) throw new HttpError(400, "Für den automatischen Versand mindestens einen Empfänger eintragen.");
  const formats = (Array.isArray(body.formats) ? body.formats : []).filter((f) => FORMATS.includes(f));
  if (!formats.length) throw new HttpError(400, "Bitte mindestens ein Format für den Anhang wählen.");
  const content = {};
  Object.keys(CONTENT).forEach((k) => { content[k] = !!(body.content && body.content[k]); });
  if (!Object.values(content).some(Boolean)) throw new HttpError(400, "Bitte mindestens einen Inhalt wählen.");
  const next = { monthly, yearly, recipients, formats, content, last: cur.last };
  await db.setMeta(META_KEY, next);
  return next;
}
async function loadDocs() {
  const r = await db.pool.query("SELECT name, value FROM documents WHERE name IN ('energy', 'settings')");
  const out = { energy: null, settings: null };
  r.rows.forEach((row) => { out[row.name] = row.value; });
  return out;
}
function previousMonth(now = new Date()) { return now.getMonth() === 0 ? { kind: "month", y: now.getFullYear() - 1, m: 11 } : { kind: "month", y: now.getFullYear(), m: now.getMonth() - 1 }; }
function parsePeriod(kind, v) {
  if (kind === "year") { const y = Number(v); return Number.isInteger(y) && y > 2000 && y < 2200 ? { kind: "year", y } : null; }
  const m = /^(\d{4})-(\d{2})$/.exec(String(v || ""));
  return m && +m[2] >= 1 && +m[2] <= 12 ? { kind: "month", y: +m[1], m: +m[2] - 1 } : null;
}
const periodKey = (p) => (p.kind === "year" ? String(p.y) : `${p.y}-${pad(p.m + 1)}`);
async function build(period, cfg) {
  cfg = cfg || await getConfig();
  const docs = await loadDocs();
  const doc = compute(docs.energy, docs.settings, period, cfg.content);
  const lineName = (docs.settings && docs.settings.lineName) || "";
  const mail = render(doc, { lineName, url: config.publicUrl || "" });
  return Object.assign(mail, { doc, files: attachmentsFor(doc, cfg.formats) });
}
async function isReleased(period) {
  const docs = await loadDocs();
  return !!released(docs.energy, periodKey(period));
}
async function send(period, { to, by, auto } = {}) {
  const cfg = await getConfig();
  const list = to && to.length ? to : cfg.recipients;
  if (!list.length) throw new HttpError(400, "Kein Empfänger eingetragen.");
  if (!(await mailer.isConfigured())) throw new HttpError(400, "Der E-Mail-Versand ist nicht eingerichtet (Einstellungen → E-Mail-Versand).");
  const mail = await build(period, cfg);
  const probe = !!(to && to.length), slot = period.kind === "year" ? "year" : "month";
  const remember = async (last) => { if (probe) return; const c = await getConfig(); c.last[slot] = last; await db.setMeta(META_KEY, c); };
  const base = { period: periodKey(period), at: Date.now(), to: list.length, auto: !!auto, by: by || null, probe };
  try {
    await mailer.send({ to: list.join(", "), subject: mail.subject, text: mail.text, html: mail.html, attachments: templates.attachments().concat(mail.files) });
    const last = Object.assign({ ok: true }, base);
    await remember(last);
    return last;
  } catch (err) {
    const last = Object.assign({ ok: false, error: String((err && err.message) || err).slice(0, 300) }, base);
    await remember(last);
    throw new HttpError(502, "Versand fehlgeschlagen: " + last.error);
  }
}
// Zeitplan: Monatsbericht für den Vormonat ab dem eingestellten Tag, sobald der Monat freigegeben ist;
// Jahresbericht im Januar am eingestellten Tag für das Vorjahr. Bei Fehlern stündlich erneut.
async function tick(now = new Date()) {
  const cfg = await getConfig();
  if (!cfg.recipients.length) return null;
  const results = [];
  const due = (plan, month) => { const [hh, mm] = plan.time.split(":").map(Number); return now >= new Date(now.getFullYear(), month, plan.day, hh, mm); };
  const retry = (last, key) => last && last.period === key && (last.ok || now - last.at < 60 * 60 * 1000);
  if (cfg.monthly.enabled && due(cfg.monthly, now.getMonth())) {
    const p = previousMonth(now), key = periodKey(p);
    if (!retry(cfg.last.month, key) && await isReleased(p)) {
      try { results.push(await send(p, { auto: true })); console.log(`[berichte] Monatsbericht ${key} gesendet`); }
      catch (err) { console.error(`[berichte] Monatsbericht ${key} nicht gesendet: ${err.message}`); }
    }
  }
  if (cfg.yearly.enabled && now.getMonth() === 0 && due(cfg.yearly, 0)) {
    const p = { kind: "year", y: now.getFullYear() - 1 }, key = periodKey(p);
    if (!retry(cfg.last.year, key)) {
      try { results.push(await send(p, { auto: true })); console.log(`[berichte] Jahresbericht ${key} gesendet`); }
      catch (err) { console.error(`[berichte] Jahresbericht ${key} nicht gesendet: ${err.message}`); }
    }
  }
  return results;
}
function startScheduler() {
  setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000).unref();
  setTimeout(() => { tick().catch(() => {}); }, 40 * 1000).unref();
}

module.exports = { compute, render, attachmentsFor, getConfig, setConfig, build, send, tick, startScheduler, previousMonth, parsePeriod, periodKey, isReleased, CONTENT, FORMATS, META_KEY };
