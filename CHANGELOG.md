# Changelog

Alle nennenswerten Änderungen am Energie Management. Aufbau nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Hauptversion bei Änderungen, die ein Eingreifen
beim Update verlangen, Nebenversion für neue Funktionen, Patch für reine Fehlerbehebungen.

Die Versionsnummer steht in `backend/package.json` (erscheint unter `/api/health` und in der Checkmk-Ausgabe) und
als `SCRIPT_VERSION` in `deploy.sh`.

## [Unveröffentlicht]

Erste Version des Energie Managements, aufgebaut auf dem Shopfloor Board 1.6.0 (Design, Anmeldung, Benutzer,
Dashboards, Maßnahmen, Sicherungen, SMB-Kopie, Checkmk und Installer übernommen).

### Neu
- **Zähler:** Verwaltung je Zähler mit Nummer, Bezeichnung, Energieart (Strom, Wasser, Gas, Druckluft), Kostenstelle,
  Haupt-/Unterzähler, Ein- und Ausbaudatum, Anfangsstand, Messfaktor, Überlaufwert und technischen Eigenschaften;
  Zählerbaum, Monatsverbrauch und alle Ablesungen je Zähler, CSV-Export.
- **Messfaktor und Überlauf** gelten ab einem Abrechnungsmonat; frühere Werte bleiben als Verlauf erhalten.
- **Zählerwechsel und Ausbau:** alter Zähler mit Ausbaustand abgeschlossen, neuer Zähler mit eigener Nummer,
  Einbaudatum und Anfangsstand; Verbrauch getrennt berechnet, Regeln und Unterzähler gehen auf die Wechselkette über.
- **Ablesung:** monatliche Erfassung je Abrechnungsmonat, letzter Stand automatisch als vorheriger Stand, sofort
  berechneter Verbrauch mit Vormonatsvergleich; Ablesedatum, Verbrauchszeitraum und Abrechnungsmonat getrennt
  (Stichtag einstellbar); fehlende Ablesungen werden angezeigt.
- **Prüfliste vor dem Speichern:** fehlender vorheriger Stand (erst nach Bestätigung mit 0 gerechnet), kleinerer
  Stand (Zählerüberlauf über den Überlaufwert, negativen Verbrauch speichern oder auslassen), rückwirkende Ablesung,
  doppelte und unmögliche Ablesungen.
- **CSV-Import und -Vorlage** für Zählerstände mit derselben Prüfung.
- **ILV:** Verrechnung auf Kostenstellen nach Regeln aus Zähler × Faktor (Summen, Differenzen, Anteile), automatisch
  aus der Zählerstruktur angelegt, von Hand bearbeitbar mit „gültig ab“; Kostenstellen, Preise je Energieart,
  Gas-Umrechnung (Brennwert × Zustandszahl), Abgleich „nicht verteilt“, CSV-Export.
- **Rückwirkende Änderungen** an Faktoren, Eigenschaften, Regeln, Preisen und Ablesungen nur nach Vorschau
  (alt / neu je Kostenstelle und Zähler), Grund und ausdrücklicher Bestätigung; der vorherige Stand wird als
  Berechnungsstand gespeichert. Berechnungsstände lassen sich auch von Hand festhalten und mit heute vergleichen.
- **Änderungsprotokoll** für alle Änderungen an Zählern, Ablesungen, Kostenstellen, Regeln und Preisen.
- **Dashboard** mit Gesamtverbrauch je Energieart, Vormonatsvergleich (Warnschwelle einstellbar), Kosten,
  fehlenden Zählerständen und Verbrauchsdiagrammen über 6–36 Monate.
- **Maßnahmen** je Energieart mit Art (Mehrverbrauch, Leckage, Zählerstörung, Einsparung) und optionalem Zählerbezug;
  Maßnahmen-Tracking.
- Teil-Wiederherstellung aus Sicherungen mit dem Teil „Energiedaten“.
- Im lokalen Testmodus (ohne Server) kann auch der Demo-Zugang Dashboards anpassen, kopieren und neu anlegen.
- Fenster für Zähler, Zählerwechsel, Ablesung, ILV-Regel und Maßnahme mit Reitern (z. B. Grunddaten, Einbau & Messung, Technische Eigenschaften); fehlt ein Pflichtfeld, springt das Fenster zum passenden Reiter.

- **Online-Anbindung der Zähler:** Der Server holt Zählerstände im einstellbaren Intervall ab — Modbus TCP,
  M-Bus über TCP-Gateway, MQTT, REST/JSON, HTTP-Push von Datenloggern (mit Schlüssel) und CSV-Ordner, dazu ein
  Simulator. Verbindungen unter Einstellungen → Zähler-Anbindung (mit Test), Zuordnung je Zähler im neuen Reiter
  „Online-Anbindung“, Online-Messwerte mit Verbrauch je Tag im Zählerdetail, Dashboard-Kachel zum Status. In der
  Ablesung erscheint der Stand zum Ablesedatum als Vorschlag („Online-Werte übernehmen“). Neue Einstellung
  `IMPORT_PATH` für den CSV-Ordner; die Messwerte stecken in den Sicherungen.

- **Mehr Werte im Dashboard:** Verbrauch und Kosten je Kostenstelle, Monatsverbrauch je Zähler, Vorjahresvergleich,
  Gesamtenergie, CO₂-Emissionen (Emissionsfaktoren in den Stammdaten), Preis und nicht verteilte Menge je Energieart;
  für online angebundene Zähler Verbrauch je Tag, Grundlast und Verbrauch je Stunde. Kacheln für jeden Monatswert
  und „Verbrauch gestern“. Die „Detaillierte Auswertung“ zeigt zusätzlich Gesamtenergie, CO₂ und den Vorjahresvergleich.

- **Zählerseite übersichtlicher:** Kacheln oben (eingebaut, Ablesung fehlt, online, ausgebaut) filtern per Klick,
  Energiearten als Schalter, Liste nach Energiearten gruppiert mit Verbrauch des fälligen Monats, kleinem
  6-Monats-Verlauf und Kennzeichen „fehlt“/„online“. Das Zählerdetail zeigt oben letzten Stand, Verbrauch mit
  Vormonatsvergleich und Kostenstelle, seltene Aktionen stehen unter „Weitere Aktionen“, der Rest in Reitern
  (Übersicht mit Monatsbalken, Ablesungen, Online, Verlauf inkl. Änderungsprotokoll, Maßnahmen).

- Beim Anpassen eines Dashboards bleibt die Leiste mit „+ Widget hinzufügen“ und „Fertig“ beim Scrollen unter der Kopfzeile stehen.

- **Monatsabrechnung mit Freigabe:** neuer Bereich „Abrechnung“ mit Ablauf (Zählerstände → Verbrauch → ILV → Kosten →
  Prüfung → Freigabe), offenen Punkten und Verrechnung je Kostenstelle. Bearbeiten markiert als geprüft, Teamleitung und
  Administration geben frei (Zeitpunkt, Person und Stand werden gespeichert). Freigegebene Monate sind gesperrt —
  Änderungen, die ihre Werte verändern würden (Ablesungen, Faktoren, Regeln, Preise), werden abgewiesen, auch vom Server.
  Wieder öffnen nur durch Administratoren mit Begründung; der frühere Stand bleibt im Verlauf. Einträge im Änderungs- und
  Sicherheitsprotokoll, CSV-Export.
- **Grundpreis** je Energieart (€/Monat, mit „gültig ab“), anteilig nach Menge auf die Kostenstellen verteilt; lässt sich
  ausblenden oder deaktivieren, ohne den Wert zu verlieren.
- **Abteilungen** an den Kostenstellen und neuer Bereich **„Auswertung“**: Kostenstellen- und Abteilungsübersicht mit
  Verbrauch und Kosten je Energieart für Monat, Quartal, Jahr oder frei gewählten Zeitraum, Vergleich mit Vorperiode oder
  Vorjahr (nur über Monate mit Werten in beiden Zeiträumen) und Details je Kostenstelle mit Zählern und Regeln.
- **Kostenstellen-Import** aus Excel (.xlsx) oder CSV mit Spaltenerkennung und Vorschau (neu/geändert/unverändert/Fehler).
- **Import von Zählerständen** jetzt auch aus Excel und mit **Importprofilen** je Energieart (Trennzeichen,
  Dezimalzeichen, Datumsformat, Spaltenzuordnung, Präfix der Zählernummer), Vorschau der gelesenen Zeilen, Prüfung der
  Energieart und **Importprotokoll** mit Datei, Profil, Person, Zeitpunkt und Fehlerliste.
- **Berichte** unter „Auswertung → Berichte“: Monat, Quartal, Jahr oder Zeitraum, gefiltert nach Kostenstelle/Abteilung
  und Energieart, Inhalt wählbar (Übersicht, Kostenstellen, Abteilungen, Zähler, Ablesungen, fehlende Ablesungen,
  Abrechnungsstatus, Maßnahmen), als Excel, PDF oder CSV.
- **Automatische Monats- und Jahresberichte per E-Mail** (Teamleitung/Administration): Monatsbericht, sobald der Vormonat
  freigegeben ist, Jahresbericht im Januar; Grundlage sind die freigegebenen Abrechnungen; Anhänge Excel/PDF/CSV; Vorschau,
  Probe an sich selbst, jederzeit ab- und wieder einschaltbar.
- **Diagramme** im Dashboard wahlweise als Balken und je Quartal oder Jahr zusammengefasst.

### Geändert
- Der Reiter „Anwenderdoku“ zeigt nur noch das Symbol (Name beim Darüberfahren), damit alle Reiter mit Namen in die Leiste passen.
- „Alle Energiedaten löschen“ entfernt auch die Abrechnungen und ist dann nur noch für Administratoren möglich.

### Entfernt (gegenüber dem Shopfloor Board)
- Daily Huddle, SQIDP-Board, Tageskennzahlen, Tagesbericht, TV-Modus und Monatsbericht.
