// Prüft die Server-Regeln der Abrechnung (backend/src/billing.js) ohne Datenbank. Aufruf: node tools/test-abrechnung.js
const b = require(require('path').join(__dirname, '../backend/src/billing.js')), assert = require('assert');
const snap = { rows: { "c|strom": { qty: 1 } } };
const rd = [{ id: "a1", month: "2026-09", kind: "read", value: 5 }];
const open = { billing: [], readings: rd };
const rel = { billing: [{ month: "2026-09", status: "released", released: { at: 1, by: "x" }, snap, history: [{ action: "check" }, { action: "release" }] }], readings: rd };
const t = (f, code) => { try { f(); assert.fail('kein Fehler'); } catch (e) { assert.equal(e.status, code, e.message); } };
// Freigabe durch Bearbeiten → 403, durch Teamleitung ok
t(() => b.check(open, rel, { perm: "editor" }), 403);
assert.deepEqual(b.check(open, rel, { perm: "manager" }), [{ month: "2026-09", action: "release" }]);
// Ablesung im freigegebenen Monat ändern → 409
t(() => b.check(rel, Object.assign({}, rel, { readings: [{ id: "a1", month: "2026-09", kind: "read", value: 6 }] }), { perm: "admin" }), 409);
t(() => b.check(rel, Object.assign({}, rel, { readings: rd.concat([{ id: "a2", month: "2026-09", kind: "read", value: 9 }]) }), { perm: "admin" }), 409);
// andere Monate frei
assert.deepEqual(b.check(rel, Object.assign({}, rel, { readings: rd.concat([{ id: "a3", month: "2026-10", kind: "read" }]) }), { perm: "editor" }), []);
// Stand verändern → 409; Verlauf kürzen → 409
t(() => b.check(rel, { billing: [Object.assign({}, rel.billing[0], { snap: { rows: {} } })], readings: rd }, { perm: "admin" }), 409);
t(() => b.check(rel, { billing: [Object.assign({}, rel.billing[0], { history: [] })], readings: rd }, { perm: "admin" }), 409);
// Wieder öffnen: Teamleitung 403, Admin ohne Grund 400, mit Grund ok
const re = (reason) => ({ billing: [{ month: "2026-09", status: "open", history: rel.billing[0].history.concat([{ action: "reopen", reason }]) }], readings: rd });
t(() => b.check(rel, re("x"), { perm: "manager" }), 403);
t(() => b.check(rel, re(" "), { perm: "admin" }), 400);
assert.equal(b.check(rel, re("Korrektur"), { perm: "admin" })[0].action, "reopen");
// Alle Energiedaten löschen: nur Administration
t(() => b.check(rel, { billing: [], meters: [], readings: [] }, { perm: "manager" }), 403);
assert.equal(b.check(rel, { billing: [], meters: [], readings: [] }, { perm: "admin" })[0].action, "wipe");
console.log('Server-Prüfung Abrechnung: alle Fälle bestanden');
