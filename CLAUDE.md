# Projektnotizen für Claude Code

Diese Datei hält fest, was für künftige Arbeiten am Energie Management wichtig ist (entstanden aus dem
Shopfloor Board 1.6.0 — Aufbau, Betrieb und Konventionen sind gleich). Bei neuen Erkenntnissen,
Entscheidungen oder Konventionen hier ergänzen (im selben PR wie die Änderung).

> **Das Repository ist öffentlich.** Keine internen Hostnamen, IP-Adressen, Domains, Zugangsdaten oder
> Personendaten in Code, Doku, Commits oder PRs. Beispiele mit Platzhaltern (`nas.firma.local`, `energie.firma.de`).

## Arbeitsweise mit dem Auftraggeber
- Kommunikation, Oberfläche, Doku, Commits, PRs und Changelog auf **Deutsch**; Antworten an den Auftraggeber
  ohne Fachjargon, mit konkreten Schritten für den Server (`./deploy.sh` …).
- Arbeiten auf dem vorgegebenen Branch `claude/…`, als **Draft-PR** gegen `main`. **Nach `main` nur auf
  ausdrücklichen Wunsch** („auf main pushen“) — dann PR auf „bereit“ setzen und per **Squash** zusammenführen.
- Nach einem Merge startet der Branch neu von `origin/main`. Weil Force-Push gesperrt ist: den alten
  Remote-Stand mit `git merge -X ours origin/<branch>` einbinden (inhaltlich identisch mit `main`), dann pushen.
- Mehrere Wünsche hintereinander dürfen in denselben offenen PR; PR-Beschreibung jeweils aktualisieren.
- Vor dem Abschluss immer testen (siehe „Testen“) und im PR die Tests nennen — auch was nicht getestet werden
  konnte.

## Changelog pflegen (Pflicht)
- Jede Änderung, die Anwender oder Betrieb betrifft (neue Funktion, geändertes Verhalten, Fehlerbehebung,
  neue Einstellung, Sicherheitsrelevantes), kommt im selben Commit/PR in `CHANGELOG.md` unter
  **„[Unveröffentlicht]“** — Rubrik „Neu“, „Geändert“, „Behoben“ oder „Entfernt“, kurz und aus Anwendersicht.
- Rein interne Änderungen (Tests, Kommentare, Formatierung) brauchen keinen Eintrag.
- Beim Zusammenführen nach `main`: „[Unveröffentlicht]“ wird zu `## [x.y.z] – JJJJ-MM-TT`, darüber ein neuer
  leerer Abschnitt, Vergleichslinks am Ende ergänzen. Version an beiden Stellen anheben:
  `backend/package.json` (+ Lock-Datei: `npm version x.y.z --no-git-tag-version` in `backend/`) und
  `SCRIPT_VERSION` in `deploy.sh`.
- Versionen: Nebenversion für neue Funktionen, Patch für reine Fehlerbehebungen, Hauptversion nur, wenn ein
  Update manuelles Eingreifen verlangt.

## Aufbau
```
frontend/index.html     gesamte Oberfläche (eine Datei, Vanilla-JS in einer IIFE, CSS inline)
frontend/nginx.conf     nginx-unprivileged (Port 8080), Proxy /api → api:3000, Drosselung Anmelde-Endpunkte
frontend/csp-hashes.js  berechnet beim Docker-Build die CSP-Hashes der Inline-Skripte (kein 'unsafe-inline')
frontend/fonts/         Inter lokal (keine externen Quellen)
frontend/docs/          Bilder der Anwenderdoku (WebP, erzeugt von tools/doku-screenshots.js im lokalen Modus)
backend/src/            Node/Express + PostgreSQL (pg)
  server.js             Start, Migration, Zeitpläne (Sicherung, Aufräumen)
  app.js                Middleware (Größenlimits, Sitzung, Herkunfts-/CSRF-Prüfung), /api/health, Fehler
  http.js               HttpError, wrap, requireUser/Edit/Manager/Admin, guardAdminAccount, passwordMatches
  routes/documents.js   Gesamtdokumente state/settings/users/energy mit Revisionsnummer und Konfliktprüfung (409)
  routes/auth.js        Anmeldung, Registrierung, Demo, „Passwort vergessen“ (Einmal-Links, Bremse)
  routes/account.js     Konten verwalten, eigenes Konto, zuletzt gewähltes Dashboard
  routes/dashboards.js  Dashboard-Liste (standard/public/private), Regeln in dashboards.js
  routes/admin.js       E-Mail-Server, Sicherheitsprotokoll, Sicherungen, SMB
  db.js                 Schema + idempotente Migration (bei jedem Start; Beispiel: CHECK-Regel erweitern)
  users.js sessions.js passwords.js audit.js
  backups.js            pg_dump/pg_restore, Zeitplan, Aufräumen, Übernahme von Dateien im Ordner
  smb.js                Kopie auf SMB-Freigabe über smbclient (Passwort per Temp-Datei, nie Befehlszeile)
  mailer.js mailtemplates.js   nodemailer, Einstellungen aus der Oberfläche (meta) vor .env, HTML-Mails
  secrets.js            AES-256-GCM für gespeicherte Passwörter, Schlüssel APP_SECRET (.env)
  monitor.js            Checkmk-Ausgabe (Local Check)
  avatars.js            Profilbilder prüfen und speichern (Tabelle user_avatars)
  cli.js                create-admin, reset-password, list-users, mail-test, audit, backup, smb-sync, checkmk
deploy.sh               Installer/Updater (Docker-Installation, .env, Bauen, Sicherung vor Update, Checkmk)
docker-compose.yml      db (postgres:17), api, web; gehärtet (read_only, cap_drop, no-new-privileges)
deploy/compose.proxy.yml  Betriebsart „proxy“ (Netz eines Reverse Proxys)
```

## Oberfläche: wichtige Konzepte (`frontend/index.html`)
Drei Skriptblöcke: `SFM` (Speicher/Abgleich), `EN` (Rechenkern, reine Funktionen) und die App (`startApp`).
- **Lokaler Modus vs. Server-Modus:** Ohne erreichbare API läuft alles im Browser mit Demo-Daten (`demoEnergy`,
  `demoState`, `localStorage`). Am Server startet die Anwendung leer.
- **Dokumente:** `state` (nur Maßnahmen `deviations` + `seq`), `settings` (Standort `lineName`, Stichtag `cutoffDay`,
  Warnschwelle `warnPct`, Mail-Absender), `users`, **`energy`** (Schlüssel `sfm-energy-v1`). Gespeichert als Ganzes
  mit Revisionsnummer (409 bei Konflikt).
- **Dokument `energy`** (Aufbau im Kopf von `window.EN`): `costCenters`, `meters` (mit `props`-Versionen
  `{from, factor, overflow}`), `readings` (`kind` install/read/remove, `date`, `month` = Abrechnungsmonat, `value`,
  `rollover`, `zeroStart`, `edits` = frühere Werte, `deleted` = weich gelöscht), `rules` (`cc`, `type`, `versions`
  `{from, terms: [{meter, factor}]}`), `prices`, `conversions` (Gas: Brennwert × Zustandszahl), `changes`
  (Änderungsprotokoll), `runs` (Berechnungsstände = festgehaltene Ergebnisse), `seq` für Kennungen.
- **Rechenkern `EN`:** einzige Stelle für Formeln. `consumptions` (Verbrauch je Ablesung = (Stand − vorheriger Stand)
  × Faktor; Überlauf nur mit `rollover` und Überlaufwert: Überlauf − alt + neu; negativ bleibt negativ; ohne
  Vorstand nur mit `zeroStart`), `meterMonth` (Summe je Abrechnungsmonat, Status ok/missing/partial/inactive),
  `chainMonth` (Wechselkette Vorgänger/Nachfolger), `allocate` (ILV je Monat: Regeln, Summen, „nicht verteilt“ =
  Hauptzähler ohne `parent` − verrechnet), `missingReadings`, `snapshot`/`diffSnapshots`, `affectedMonths`,
  `autoRulesForMeter` (+1 × Zähler; beim Hauptzähler anteilig abziehen), `changeMeter`, CSV-/Datums-Parser.
  Berechnete Werte werden nie gespeichert — außer ausdrücklich als Berechnungsstand (`runs`).
- **Gültig ab:** Faktor/Überlauf, Regeln, Preise, Umrechnung haben Versionen je Monat (`EN.versionAt`).
- **Jede Änderung an Energiedaten läuft über `commitChange({from, kind, text, mutate})`:** betrifft sie Monate mit
  Ablesungen (`EN.affectedMonths`), wird `mutate` erst auf einer Kopie ausgeführt → Vorschau `#previewDialog`
  (Verrechnung + Zähler-Monatswerte), Pflicht-Grund und Bestätigung → `storeRun` (Stand davor) → `mutate` auf
  `energy` → `logChange` mit `retro`. `mutate` muss deshalb zweimal lauffähig sein und nur über `doc` arbeiten.
- **Ablesungen speichern:** `checkAndSave` → `checkEntry` (Fehler/Warnungen/Hinweise) → Prüfliste `#issueDialog`
  (Entscheidungen `zero`, `neg` = rollover/negative/skip) → `saveEntries`. CSV-Import nutzt dieselbe Prüfung.
- **Abrechnungsmonat:** `EN.billingMonth(date, cutoffDay)` — bis zum Stichtag Vormonat; fällig ist `DUE_MONTH`
  (Vormonat von heute). Anzeige-Zwischenspeicher `calc()`/`invalidateCalc()` (nach jeder Änderung `energyChanged`).
- **Kategorien** `CATS` der Maßnahmen = Energiearten (`EN.TYPES`) + `allg`; Arten `DEV_SUB_LIST`; `dev.meter` optional.
- **Wertekatalog** `VALUE_CATALOG` (`q:<art>` Verbrauch, `c:<art>` Kosten, `c:total`) + `valueOfMonth(key, monat)`:
  einzige Quelle für Dashboard-Diagramme. Diagramme arbeiten mit Monatsschlüsseln `JJJJ-MM` als `isos`.
- **Dashboards:** wie im Shopfloor Board (Liste, Sichtbarkeit standard/public/private, `owner` = Anmeldename,
  Tabelle `dashboards`, `sanitizeWidgets`, `DW_MIN`). Widget-Typen: `bilanz` (Übersicht je Energieart), `tile`
  (`t:<art>`, `cost`, `missing`, `actions`), `chart` (max. 5 Werte, 2 Einheiten), `missing` (Liste). Monatswahl
  `dashMonth`, Zeitraum `dashSpan`.
- **Berechtigungen** `can()`: viewer, editor (bearbeiten), manager (+ löschen, Stammdaten, Benutzer ohne Admins),
  admin. Der Server prüft dasselbe (`http.js`, `users.js`).
- **Anwenderdoku** im Array `DOCS` (Gruppen `DOC_GROUPS`) — bei neuen Funktionen mitpflegen; Bilder mit
  `node tools/doku-screenshots.js` neu erzeugen.
- **Profilbilder, Darstellung hell/dunkel, Passwort vergessen, Benutzerverwaltung:** unverändert aus dem Shopfloor Board.
- **Kopfzeile:** Speicherstatus nur bei Problemen; Datum → Ablesung des fälligen Monats; Zähler am Reiter „Ablesung“
  = fehlende Ablesungen.

- **Teil-Wiederherstellung:** siehe Standard „Wiederherstellung & Datenkonsistenz“ unten. Code: `backups.inspect`,
  `backups.restoreParts` (Plan → Prüfung → Transaktion), API `GET /api/backups/:file/contents`,
  `POST /api/backups/:file/restore` mit `parts` (energy, deviations, settings, users, dashboards), `select`
  {deviations, users, dashboards, keepPasswords}, `dryRun`; UI `#restoreDialog` (Einzelauswahl `rsPick-*`, Vorschau `#rsPreview`, erst danach `#rsOk`).

## Standard: Wiederherstellung & Datenkonsistenz
Verbindlich für jede Funktion, die Daten aus Sicherungen, Dateien oder anderen Quellen teilweise übernimmt (heute:
Teil-Wiederherstellung in `backups.js`). Neue Datenfelder oder Tabellen müssen hier einem Teil zugeordnet werden.
1. **Einheiten statt Einzelfelder.** Zusammengehöriges wird nur gemeinsam übernommen:
   - **Energiedaten** = ganzes Dokument `energy` (Zähler, Ablesungen, Kostenstellen, Regeln, Preise, Umrechnung,
     Protokoll, Berechnungsstände) — nur als Ganzes, weil Verbräuche, Wechselketten und Regeln voneinander abhängen.
   - **Maßnahme** = ganzes Objekt aus `state.deviations` (inkl. 5-Why, Phase, `meter`).
   - **Konto** = Zeile `users` + Profilbild `user_avatars` (Passwort-Hash nur auf ausdrücklichen Wunsch).
   - **Dashboard** = ganze Zeile `dashboards`; **Stammdaten** = ganzes Dokument `settings`.
   - Berechnete Werte (Verbräuche, Verrechnung, Kosten) werden **nie** übernommen — sie entstehen neu.
2. **Zuordnung über eindeutige Kennungen:** Maßnahme über `id`, Konto über Anmeldenamen (`username`, ohne
   Groß-/Kleinschreibung), Dashboard über `id`. Vorhanden → auf den Stand der Quelle setzen,
   fehlt → neu anlegen. Nicht gewählte Datensätze bleiben unverändert. Zähler werden nur erhöht, nie zurückgesetzt
   (`state.seq` > höchste Abweichungsnummer, Sequenz von `users.id`).
3. **Verknüpfungen melden:** Maßnahme ↔ Zähler über `meter` (Hinweis, wenn der Zähler in den Energiedaten fehlt); privates Dashboard ↔ Besitzer
   (Anmeldename; alte Sicherungen mit Anzeigename werden nach der Übernahme per `dashboards.migrate` umgestellt). Geänderte, nicht mit gewählte Gegenstücke → Hinweis in der Vorschau; fehlender Besitzer → Abbruch.
4. **Konflikte brechen ab, statt zu überschreiben:** Name oder E-Mail eines Kontos wird heute von einem anderen
   Konto benutzt; kein aktiver Administrator mit Passwort mehr; privates Dashboard ohne Besitzer → HTTP 409 mit
   verständlicher Meldung, **nichts** wird geändert.
5. **Erst Vorschau, dann Ausführung:** `dryRun` liefert ersetzt/neu/entfernt/unverändert je Teil und Hinweise, ohne
   zu schreiben und ohne Sicherung. Die Oberfläche erlaubt das Ausführen erst nach einer Vorschau zur **gleichen**
   Auswahl.
6. **Alles oder nichts:** Alle Änderungen in **einer** Transaktion mit `lockRevision`; vor dem Speichern prüft
   `validateResult` das Ergebnis (eindeutige Maßnahmennummern, Zähler, Administrator,
   eindeutige Kontonamen, Dashboard-Besitzer) — ein Verstoß bricht ab (Rollback). Danach `bumpRevision`, damit alle
   Geräte neu laden; offene Bearbeitungen anderer scheitern an der Revisionsprüfung (409) statt alte Daten zu schreiben.
7. **Rückweg und Nachweis:** Vor jeder echten Übernahme automatische Sicherung („vor Teil-Wiederherstellung …“);
   Sicherheitsprotokoll mit Teilen, Zeitraum und den betroffenen Datensätzen (`records`, gekürzt).
8. **Testpflicht:** Am Test-Server Daten gezielt ändern/löschen, einzelne Datensätze zurückholen und prüfen, dass genau
   diese stimmen und alles andere unverändert ist; dazu die Abbruchfälle (Namenskonflikt, fehlender Besitzer, leere
   Auswahl) und „Vorschau ändert nichts“ (Vorlage: Skripte wie apitest10/11 aus der Entwicklung).

## Betrieb
- `./deploy.sh` installiert/aktualisiert (Sicherung → `git pull` → bauen → starten); `./deploy.sh config`
  ändert die `.env` (einzige Quelle der Einstellungen; Umgebungsvariablen nur als Eingabe beim ersten Lauf).
  Weitere Befehle: status, logs, backup, admin, users, reset-password, mail-test, smb, checkmk, audit, stop.
- Betriebsarten: `port` (eigener Port, z. B. hinter einem Reverse Proxy auf einem anderen Rechner) oder `proxy`
  (im Docker-Netz eines Proxys wie Nginx Proxy Manager). Das Produktivsystem läuft in `port` hinter einem
  Nginx Proxy Manager auf einem anderen Rechner; auf dem Server läuft ein Checkmk-Agent.
- Einstellungen in der **Oberfläche** (nicht `.env`): Zeitplan/Aufbewahrung der Sicherungen, SMB-Freigabe,
  E-Mail-Versand (`SMTP_*` in der `.env` sind nur Startwerte).
- `APP_SECRET` (von `deploy.sh` erzeugt, nie abgefragt) verschlüsselt SMB-/SMTP-Passwörter; nicht ändern.
- Checkmk: Local Check unter `/usr/lib/check_mk_agent/local/300/energie_<projekt>` (fragt per `docker exec`).
- Erstes Konto wird Administrator; Passwort zurücksetzen: `./deploy.sh reset-password <Name>`.

## Testen
Es gibt keine Testsuite im Repo; geprüft wird mit Playwright (Chromium ist vorinstalliert) und Node-Skripten.
- **Oberfläche im lokalen Modus:** `file:///…/frontend/index.html` öffnen, registrieren über `#modeToggle`,
  `#lFull` (Name), `#lName` (Anmeldename), `#lPass`/`#lPass2`, `#loginSubmit` — Demo-Daten sind dann vorhanden.
- **Server:** `docker compose` mit Test-`.env` (Projekt z. B. `entest`, Web-Port 18080). In der Sandbox: Docker-Hub-
  Limit und gesperrte Alpine-Paketquellen — Basis-Images ggf. lokal umtaggen bzw. die API direkt mit Node auf dem
  Host starten (DB-Port freigeben); `smbclient`/Samba per apt auf dem Host für SMB-Tests, einfacher SMTP-Empfänger
  für Mail-Tests. nginx drosselt Anmelde-Endpunkte (10/min) — in API-Tests Pausen einplanen.
- Rechenkern: `node tools/test-rechenkern.js` (lädt `window.EN` aus `index.html`; `global.window = {}`, den
  zweiten `<script>`-Block ausführen) — Überlauf, Zählerwechsel, Start bei 0, ILV und Vorschau-Vergleich.
- Vor jedem Commit: JS-Syntax der Inline-Skripte prüfen
  (`node -e` mit `new Function(...)` über alle `<script>`-Blöcke), `node --check` für Backend-Dateien,
  `bash -n deploy.sh` (ggf. shellcheck), bei UI-Änderungen auf Seitenfehler und CSP-Verstöße achten.
