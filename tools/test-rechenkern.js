// Prüft den Rechenkern (window.EN aus frontend/index.html): Faktor, Überlauf, Zählerwechsel, Start bei 0,
// Gas-Umrechnung, ILV mit Preisen, Vorschau-Vergleich und CSV-Parser. Aufruf: node tools/test-rechenkern.js
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const core = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('window.EN ='));
global.window = {}; new Function(core)();
const EN = window.EN, assert = require('assert');
const who = { by: "t", at: 1 };
let d = EN.normalize({});
d.costCenters.push({ id: "c1", no: "100", name: "Halle" }, { id: "c2", no: "200", name: "Büro" });
function meter(no, type, cc, parent, inst, iv, ov) {
  const m = { id: EN.nextId(d, "m"), no, name: no, type, costCenter: cc, parent, installed: inst, props: [{ from: "1900-01", factor: 1, overflow: ov || null }] };
  d.meters.push(m);
  d.readings.push({ id: EN.nextId(d, "a"), meter: m.id, kind: "install", date: inst, month: EN.billingMonth(inst), value: iv });
  EN.autoRulesForMeter(d, m, EN.monthOf(inst), who); return m;
}
function read(m, date, value, extra) { const r = Object.assign({ id: EN.nextId(d, "a"), meter: m.id, kind: "read", date, month: EN.billingMonth(date), value }, extra || {}); d.readings.push(r); return r; }
assert.equal(EN.billingMonth("2026-12-01"), "2026-11");
assert.equal(EN.billingMonth("2026-11-15"), "2026-11");
const H = meter("H1", "strom", "c1", null, "2026-01-01", 1000, 100000);
const U = meter("U1", "strom", "c2", H.id, "2026-01-01", 50);
read(H, "2026-02-01", 2000); read(U, "2026-02-01", 350);
let a = EN.allocate(d, "2026-01");
const byCc = (a) => Object.fromEntries(a.rows.map(r => [r.cc, r.qty]));
assert.deepEqual(byCc(a), { c1: 700, c2: 300 }); assert.equal(a.totals.strom.measured, 1000); assert.equal(a.totals.strom.unassigned, 0);
// overflow
read(H, "2026-03-01", 99500); read(U, "2026-03-01", 400);
read(H, "2026-04-01", 500, { rollover: true }); read(U, "2026-04-01", 500);
assert.equal(EN.meterMonth(d, H.id, "2026-03").energy, 1000);
assert.equal(EN.allocate(d, "2026-02").totals.strom.measured, 97500);
assert.equal(EN.meterMonth(d, H.id, "2026-03").qty, 1000);
// negative without rollover stays negative
const r5 = read(U, "2026-05-01", 450); assert.equal(EN.meterMonth(d, U.id, "2026-04").qty, -50); assert(EN.meterMonth(d, U.id, "2026-04").flags.negative);
// meter change of H mid-May
const N = EN.changeMeter(d, H.id, { no: "H2", removeDate: "2026-05-15", removeMonth: EN.billingMonth("2026-05-15"), removeValue: 900, installDate: "2026-05-15", installValue: 0 }, who);
assert.equal(U.parent, N.id);
read(N, "2026-06-01", 300); read(U, "2026-06-01", 500);
// H April: 500 (01.04->01.05 wait H read 2026-05-01? no) 
assert.equal(EN.meterMonth(d, H.id, "2026-05").qty, 400, "old meter 01.04 500 -> 15.05 900");
assert.equal(EN.meterMonth(d, N.id, "2026-05").qty, 300);
assert.equal(EN.chainMonth(d, H.id, "2026-05").qty, 700);
a = EN.allocate(d, "2026-05"); assert.deepEqual(byCc(a), { c1: 650, c2: 50 }); assert.equal(a.totals.strom.measured, 700);
// missing: H April? H has 2026-05-01 reading? no -> H month 2026-04 missing

// zero start
const G = { id: "mg", no: "G1", type: "gas", installed: "2026-01-01", props: [{ from: "1900-01", factor: 1 }] }; d.meters.push(G);
read(G, "2026-02-01", 100);
let mm = EN.meterMonth(d, "mg", "2026-01"); assert(mm.flags.noPrev); assert.equal(mm.status, "partial");
d.readings[d.readings.length - 1].zeroStart = true;
mm = EN.meterMonth(d, "mg", "2026-01"); assert.equal(mm.qty, 100); assert.equal(mm.energy, 0); assert(mm.flags.noConv);
d.conversions.push({ type: "gas", from: "2026-01", brennwert: 11.2, zustandszahl: 0.95 });
assert.equal(EN.meterMonth(d, "mg", "2026-01").energy, 1064);
// retro factor change preview
d.prices.push({ type: "strom", from: "2026-01", price: 0.25 });
const before = EN.snapshot(d, EN.affectedMonths(d, "2026-03"));
const d2 = EN.clone(d); EN.setMeterProps(EN.meterById(d2, U.id), "2026-03", { factor: 2, overflow: null }, who);
const after = EN.snapshot(d2, EN.affectedMonths(d2, "2026-03"));
const diff = EN.diffSnapshots(before, after); assert(diff.length > 0, 'Vorschau zeigt Unterschiede');
assert.equal(EN.allocate(d, "2026-01").rows[0].cost, 175);
assert.deepEqual(EN.parseCsv('Zähler;Datum;Stand\n"H1";01.12.2026;"1.234,5"\n'), [["Zähler","Datum","Stand"],["H1","01.12.2026","1.234,5"]]);
assert.equal(EN.num("1.234,5"), 1234.5); assert.equal(EN.parseDate("1.12.26"), "2026-12-01"); assert.equal(EN.parseMonth("November 2026"), "2026-11");
console.log('Rechenkern: alle Prüfungen bestanden');
