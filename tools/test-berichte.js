// Prüft die automatischen Berichte (backend/src/reports.js) ohne Datenbank: Werte aus freigegebenen Abrechnungen,
// Anhänge Excel/PDF/CSV. Aufruf: node tools/test-berichte.js [Ausgabeordner]
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const core = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('window.EN ='));
global.window = {}; new Function(core)();
const EN = window.EN, who = { by: "t", at: 1 };
const reports = require(path.join(__dirname, '../backend/src/reports.js'));
const d = EN.normalize({});
d.costCenters.push({ id: "c1", no: "4100", name: "Gießerei", dept: "Produktion" }, { id: "c2", no: "4800", name: "Büro", dept: "Verwaltung" });
const mk = (no, cc, parent) => { const m = { id: EN.nextId(d, "m"), no, name: no, type: "strom", costCenter: cc, parent, installed: "2025-01-01", props: [{ from: "1900-01", factor: 1 }] };
  d.meters.push(m); d.readings.push({ id: EN.nextId(d, "a"), meter: m.id, kind: "install", date: "2025-01-01", month: "2024-12", value: 0 }); EN.autoRulesForMeter(d, m, "2025-01", who); return m; };
const H = mk("E-1", "c1", null), U = mk("E-2", "c2", H.id);
for (let i = 1; i <= 24; i++) { const date = EN.addMonths("2025-01", i) + "-01"; d.readings.push({ id: EN.nextId(d, "a"), meter: H.id, kind: "read", date, month: EN.billingMonth(date), value: i * 1000 }, { id: EN.nextId(d, "a"), meter: U.id, kind: "read", date, month: EN.billingMonth(date), value: i * 300 }); }
d.prices.push({ type: "strom", from: "2025-01", price: 0.2, base: 100, baseMode: "on" });
["2025-03", "2026-01", "2026-02", "2026-03"].forEach((mo) => d.billing.push({ month: mo, status: "released", released: { at: 1, by: "Test" }, snap: EN.billingSnap(d, mo), history: [] }));
const content = { summary: true, months: true, cc: true, dept: true, meters: true, status: true };
const m = reports.compute(d, { lineName: "Werk Test" }, { kind: "month", y: 2026, m: 2 }, content);
const sum = m.sections.find(s => s.key === "summary").rows[0];
assert.equal(sum[2], 1000); assert.equal(sum[3], 1000); assert.equal(sum[5], 300);   // 1000 kWh × 0,20 € + 100 € Grundpreis
assert.equal(sum[6], 1000); assert.equal(sum[7], 0);                                  // Vorjahr März 2025 freigegeben
const cc = m.sections.find(s => s.key === "cc").rows;
assert.deepEqual(cc.map(r => [r[1], r[4], r[6], r[7]]), [["4100", 700, 210, 70], ["4800", 300, 90, 30]]);
const y = reports.compute(d, {}, { kind: "year", y: 2026 }, content);
assert.equal(y.released, 3); assert.equal(y.sections.find(s => s.key === "months").rows.filter(r => r[1] === "freigegeben").length, 3);
const ys = y.sections.find(s => s.key === "summary").rows[0];
assert.equal(ys[5], 900); assert.equal(ys[8], 300); assert.equal(ys[9], 0);   // Vergleich nur März (in beiden Jahren freigegeben)
assert.equal(y.sections.find(s => s.key === "summary").rows.length, 1);       // Energiearten ohne Werte entfallen
const mail = reports.render(m, { lineName: "Werk Test", url: "" });
assert(/Monatsbericht März 2026/.test(mail.subject) && /300,00 €/.test(mail.html));
const files = reports.attachmentsFor(y, ["xlsx", "pdf", "csv"]);
assert.equal(files.length, 3);
assert(files[1].content.slice(0, 8).toString() === "%PDF-1.4" && /%%EOF\s*$/.test(files[1].content.toString("latin1")));
assert(files[0].content.readUInt32LE(0) === 0x04034b50);
if (process.argv[2]) files.forEach(f => fs.writeFileSync(path.join(process.argv[2], f.filename), f.content));
console.log('Berichte: alle Prüfungen bestanden');
