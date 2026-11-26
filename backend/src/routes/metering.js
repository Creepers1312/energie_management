"use strict";
// Online-Anbindung: Verbindungen, Messwerte, Status, Test, sofort abfragen, Push-Empfang
const metering = require("../metering");
const audit = require("../audit");
const { wrap, requireUser, requireEdit, requireAdmin } = require("../http");

function register(app) {
  // Verbindungen: alle Angemeldeten sehen die Liste (für die Auswahl am Zähler), ändern nur die Administration
  app.get("/api/connections", wrap(async (req, res) => {
    requireUser(req);
    res.json({ connections: await metering.listConnections(req.user.perm === "admin"), types: metering.TYPE_LABEL });
  }));
  app.put("/api/connections", wrap(async (req, res) => {
    requireAdmin(req);
    const saved = await metering.saveConnections((req.body || {}).connections);
    await audit.log(req, "metering.connections", { count: saved.length, names: saved.map((c) => c.name + " (" + c.type + ")").slice(0, 20) });
    res.json({ connections: await metering.listConnections(true) });
  }));
  app.post("/api/connections/test", wrap(async (req, res) => {
    requireAdmin(req);
    const body = req.body || {};
    try { res.json({ ok: true, result: await metering.test(body.connection || {}, body.source || null) }); }
    catch (e) { if (e.status && e.status < 500) throw e; res.json({ ok: false, error: e.message }); }
  }));

  // Messwerte und Status (alle Angemeldeten)
  app.get("/api/meter-values", wrap(async (req, res) => {
    requireUser(req);
    res.json({ values: await metering.series(String(req.query.meter || ""), req.query.from, req.query.to, req.query.max) });
  }));
  app.get("/api/meter-values/at", wrap(async (req, res) => {
    requireUser(req);
    res.json({ values: await metering.valuesAt(req.query.ts) });
  }));
  app.get("/api/meter-status", wrap(async (req, res) => {
    requireUser(req);
    res.json({ status: await metering.statusList() });
  }));
  app.post("/api/meters/:id/poll", wrap(async (req, res) => {
    requireEdit(req);
    res.json({ result: await metering.pollNow(req.params.id) });
  }));

  // Push von Datenloggern/Gateways: ohne Sitzung, mit Schlüssel der Verbindung (Authorization: Bearer …)
  app.post("/api/ingest/:conn", wrap(async (req, res) => {
    const auth = String(req.headers.authorization || "");
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : String(req.headers["x-api-key"] || "");
    res.json(await metering.ingest(req.params.conn, token, req.body));
  }));
}

module.exports = { register };
