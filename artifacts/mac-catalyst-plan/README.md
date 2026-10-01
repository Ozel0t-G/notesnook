# Mac Catalyst Arbeitsordner (Start hier)

Ziel: Die Mac-Catalyst-Version der iOS-App (`apps/mobile`, Produktname **VeyraN**) wird zu einer vollwertigen, Apple-typischen macOS-App wie Notes, Mail oder Erinnerungen auf macOS 26/27.

Grundlage ist das Design-Assessment vom 1. Okt. 2026 (Build `Release-maccatalyst`, Commit `446a38391`, Reifegrad **4/10**): 98 Befunde, davon 20 aus der laufenden App und 78 aus einem Code-Audit. Sie sind auf 12 Arbeitspakete verteilt.

## So arbeitest du damit (für Claude)

1. Lies [`CONTEXT.md`](CONTEXT.md): Architektur der Mac-Teile, Build, Prüfung ohne Computer Use, Fallstricke, Git-Regeln.
2. Öffne [`PLAN.md`](PLAN.md) und nimm das erste Paket mit Status „offen“, dessen Abhängigkeiten erledigt sind. Ein Paket pro Session.
3. Arbeite die Paketdatei unter `packages/` ab: Ziel → Screenshots ansehen (Read-Tool) → Vorgehen → Abnahmekriterien.
4. Prüfe mit `tools/mac-app.sh` und lege Vorher/Nachher-Screenshots in `screenshots/` ab.
5. Setze die Checkboxen in der Paketdatei, den Status in `PLAN.md` und fülle „Ergebnis“ aus.

Prompt für eine neue Session:

```text
Lies artifacts/mac-catalyst-plan/README.md und arbeite das nächste offene Paket aus PLAN.md ab.
```

Oder gezielt: `… und arbeite packages/WP01-runtime-bugs.md ab.`

## Inhalt

| Pfad | Zweck |
|---|---|
| [`PLAN.md`](PLAN.md) | Reihenfolge, Abhängigkeiten, Status, Zuordnung aller Befunde zu Paketen |
| [`CONTEXT.md`](CONTEXT.md) | Technischer Kontext, Build- und Prüfbefehle, Regeln |
| `packages/WPxx-*.md` | Ein Arbeitspaket: Ziel, Screenshots, Schritte, Abnahme, Befunde mit Belegen |
| `screenshots/` | Ist-Zustand vom 1. Okt. 2026 (nur App-Fenster); neue Aufnahmen als `WPxx-after-*.png` |
| [`findings.json`](findings.json) | Alle Befunde und Pakete maschinenlesbar (für Skripte oder Filter) |
| [`menu-bar-snapshot.txt`](menu-bar-snapshot.txt) | Menüleiste der App, zur Laufzeit ausgelesen |
| [`deepseek-audit-raw.md`](deepseek-audit-raw.md) | Original-Code-Audit (vor den Laufzeitkorrekturen W3, K5, E3, I9) |
| `tools/` | `mac-app.sh` plus Swift-Helfer: App im Hintergrund starten, Menüs auslösen, Elemente drücken, Fenster fotografieren |

## Screenshots (Ist-Zustand)

| Datei | Zeigt | Wichtigste Befunde |
|---|---|---|
| [01-main-dark.png](screenshots/01-main-dark.png) | Hauptfenster dunkel, 1400 × 872 pt | R1 drei Chrome-Zeilen, R2 leerer Toolbar-Streifen über der Liste, R3 drei Suchen, R4 Segment neben den Ampeln, R5 Notizzeile, R6 Web-Formatleiste, R7 keine Textspalte, R8 schwarze Sidebar |
| [02-tasks-dark.png](screenshots/02-tasks-dark.png) | Aufgaben (⌘2) | R12 Large Title, „Edit“, Kacheln, Chevrons, Sidebar wechselt |
| [03-search-empty.png](screenshots/03-search-empty.png) | Suche (⌘3) | R11 komplett leer |
| [04-settings-sheet.png](screenshots/04-settings-sheet.png) | Einstellungen (⌘,) | R13 iOS-Sheet, dimmt das ganze Fenster |
| [05-settings-appearance-no-back.png](screenshots/05-settings-appearance-no-back.png) | Settings › Appearance | R14 kein Zurück-Knopf, R15 Checkbox-Ausrichtung |
| [06-settings-light-invisible-checkboxes.png](screenshots/06-settings-light-invisible-checkboxes.png) | dieselbe Seite hell | R16 leere Checkboxen unsichtbar |
| [07-main-light-toolbar-mismatch.png](screenshots/07-main-light-toolbar-mismatch.png) | App hell, System dunkel | R9 Toolbar bleibt dunkel |
| [08-tasks-light.png](screenshots/08-tasks-light.png) | Aufgaben hell | Akzent aus dem App-Theme statt System |
| [09-min-size-900x600.png](screenshots/09-min-size-900x600.png) | kleinste Fenstergröße | R10 Formatleiste abgeschnitten, Sidebar klappt nicht ein |
| [10-list-more-button-zoom.png](screenshots/10-list-more-button-zoom.png) | ⋮-Knopf vergrößert | R17 überlagerter Menüindikator |

Nicht abgedeckt, weil dafür Maus oder Tastatur nötig gewesen wären: Kontextmenüs, Sheets einzelner Notizaktionen, Login/Intro, Tastaturfokus.

## Leitbild (Apple-Soll in einem Satz pro Bereich)

- **Fenster:** ein Toolbar-Band, Titel/Untertitel, Größe wird gemerkt, Spalten ziehbar, Sidebar klappt bei schmalen Fenstern ein.
- **Sidebar:** transluzentes Material, Auswahl in Systemakzent (grau im inaktiven Fenster), SF Symbols, aufklappbare Gruppen.
- **Liste:** 13/11 pt, Titel + Datum + Vorschau, keine Wischgesten, ⌘/⇧-Klick, Pfeiltasten.
- **Editor:** zentrierte Textspalte, Format über „Aa“-Popover und Format-Menü, ⌘F/⌥⌘F im Text.
- **Dialoge:** Sheets hängen am Fenster, Popover am Auslöser, Einstellungen als eigenes Fenster (⌘,), keine Bottom-Sheets.
- **Menüs:** vollständige Standardmenüs mit Standardkürzeln, Befehle ohne Ziel ausgegraut.
