"use strict";
// Abrechnung je Monat (Dokument „energy“, Liste „billing“): Prüfung beim Speichern auf dem Server.
// Die Oberfläche rechnet genau nach (gesperrt ist, was die Werte eines freigegebenen Monats ändern würde). Der Server
// sichert zusätzlich ab, dass niemand die Regeln über die API umgeht:
//   • freigeben nur Teamleitung/Administration, wieder öffnen nur Administration mit Begründung
//   • ein freigegebener Stand (snap, released) bleibt unverändert, der Verlauf wird nur ergänzt
//   • Ablesungen eines freigegebenen Monats lassen sich weder ändern, löschen noch neu anlegen
const { HttpError } = require("./http");

function list(doc) { return doc && Array.isArray(doc.billing) ? doc.billing.filter((b) => b && typeof b === "object") : []; }
function byMonth(doc) {
  const out = {};
  list(doc).forEach((b) => { if (typeof b.month === "string") out[b.month] = b; });
  return out;
}
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

// Liefert die Ereignisse fürs Sicherheitsprotokoll; wirft HttpError bei einem Verstoß.
function check(oldDoc, newDoc, user) {
  const before = byMonth(oldDoc), after = byMonth(newDoc), events = [];
  const perm = user && user.perm;
  const months = Object.keys(before).concat(Object.keys(after)).filter((m, i, a) => a.indexOf(m) === i);
  months.forEach((m) => {
    const o = before[m] || { status: "open", history: [] }, n = after[m] || { status: "open", history: [] };
    const oh = Array.isArray(o.history) ? o.history : [], nh = Array.isArray(n.history) ? n.history : [];
    if (oh.length > nh.length || !same(oh, nh.slice(0, oh.length))) {
      throw new HttpError(409, `Der Verlauf der Abrechnung ${m} darf nicht verändert werden.`);
    }
    const added = nh.slice(oh.length);
    if (o.status === "released" && n.status === "released") {
      if (!same(o.snap, n.snap) || !same(o.released, n.released)) {
        throw new HttpError(409, `Die freigegebene Abrechnung ${m} kann nicht verändert werden.`);
      }
    }
    if (o.status !== "released" && n.status === "released") {
      if (perm !== "admin" && perm !== "manager") throw new HttpError(403, "Freigeben dürfen nur Teamleitung und Administration.");
      if (!n.snap || !n.released || !added.some((h) => h && h.action === "release")) {
        throw new HttpError(400, `Freigabe ${m} unvollständig.`);
      }
      events.push({ month: m, action: "release" });
    }
    if (o.status === "released" && n.status !== "released") {
      if (perm !== "admin") throw new HttpError(403, "Eine freigegebene Abrechnung kann nur ein Administrator wieder öffnen.");
      const h = added.filter((x) => x && x.action === "reopen")[0];
      if (!h || !String(h.reason || "").trim()) throw new HttpError(400, `Zum Wiederöffnen der Abrechnung ${m} ist eine Begründung nötig.`);
      events.push({ month: m, action: "reopen", reason: String(h.reason).slice(0, 200) });
    }
  });
  // Ablesungen freigegebener Monate (die es vorher wie nachher sind) bleiben unverändert
  const locked = new Set(Object.keys(before).filter((m) => before[m].status === "released" && after[m] && after[m].status === "released"));
  if (locked.size) {
    const key = (r) => r && typeof r === "object" && locked.has(r.month) && r.kind !== "install";
    const oldR = {}, newR = {};
    (Array.isArray(oldDoc && oldDoc.readings) ? oldDoc.readings : []).filter(key).forEach((r) => { oldR[r.id] = r; });
    (Array.isArray(newDoc.readings) ? newDoc.readings : []).filter(key).forEach((r) => { newR[r.id] = r; });
    const ids = Object.keys(oldR).concat(Object.keys(newR)).filter((x, i, a) => a.indexOf(x) === i);
    const bad = ids.filter((id) => !same(oldR[id], newR[id]));
    if (bad.length) {
      const r = newR[bad[0]] || oldR[bad[0]];
      throw new HttpError(409, `Ablesungen der freigegebenen Abrechnung ${r.month} können nicht geändert werden — zuerst wieder öffnen (Administrator).`);
    }
  }
  return events;
}

module.exports = { check };
