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

### Entfernt (gegenüber dem Shopfloor Board)
- Daily Huddle, SQIDP-Board, Tageskennzahlen, Tagesbericht, TV-Modus und Monatsbericht.
