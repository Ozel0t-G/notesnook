# WP08 · Editor wie Notes: Textspalte, Aa-Format, Suchen

**Status:** offen · **Befunde:** 10 (P1×5 · P2×4 · P3×1) · **Abhängig von:** WP02, WP10

## Ziel

Zentrierte Textspalte, Mac-Typografie, Format über Toolbar-Popover und das Format-Menü, ⌘F und ⌥⌘F im Text, Drag & Drop von Dateien.

## Screenshots (Ist-Zustand)

Mit dem Read-Tool ansehen, bevor du anfängst.

![01-main-dark.png](../screenshots/01-main-dark.png)
![09-min-size-900x600.png](../screenshots/09-min-size-900x600.png)

## Vorgehen

1. WebView-Editor: `packages/editor-mobile/src/components/editor.tsx:480,596-612`, `title.tsx:97-120`, `utils/mac.ts`. Bei `isMacCatalyst`: `max-width: 46rem; margin: 0 auto`, Titel ca. 22 pt.
2. Formatleiste auf dem Mac durch „Aa“-Toolbar-Item mit Popover ersetzen (Titel, Überschrift, Unterüberschrift, Text, Monospace, Listen, Checkliste). Keine „px“-Angaben.
3. Format-Menü (`AppDelegate.mm:241-386`) um Stile und Listen erweitern, Kommandos per Emitter an den Editor (E3/K2).
4. Edit › Find: Find…, Find & Replace, Next/Previous an `packages/editor/src/toolbar/popups/search-replace.tsx` binden (E4/K3).
5. Wortzahl und „Add tag“ aus der Kopfzeile in Info-Popover bzw. unter den Text (R7). Drop von Bildern und Dateien (E7).
6. Editor-Bundle bauen: `npm run tx editor-mobile:build`.

## Abnahmekriterien

- [ ] Bei 1400 pt Fensterbreite ist die Textspalte zentriert und ≤ ca. 740 pt.
- [ ] ⌘F öffnet Suchen im Text, ⌥⌘F Suchen & Ersetzen.
- [ ] Format › Überschrift setzt eine Überschrift. ⌘B, ⌘I, ⌘U wirken.
- [ ] Bild aus dem Finder in die Notiz ziehen fügt es als Anhang ein.
- [ ] Release-Build für Catalyst baut fehlerfrei, iOS-Build ebenso.

## Befunde

#### E1

- **Prio:** P1 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 4. Editor
- **Befund:** Keine maximale Textbreite/zentrierte Spalte: `editor-mobile/src/components/editor.tsx:480` (`maxWidth:"100vw"`), 12 px Padding (`:596-612`), Titel 100 % (`title.tsx:120`).
- **So macht es macOS:** macOS Notizen begrenzt die Textspalte (~600-700 pt, zentriert).
- **Fix:** Im WebView bei `isMacCatalyst` `max-width: 46rem; margin: 0 auto`.
- [ ] erledigt

#### E3

- **Prio:** P1 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 4. Editor
- **Befund:** Laufzeit: Das Format-Menü existiert als UIKit-Standard (Font: Bold, Italic, Underline, Bigger, Smaller, Show Colors; Text: Ausrichtung). `AppDelegate.mm:241-386` verdrahtet es nicht mit dem WKWebView-Editor. Absatzstile, Listen und Checklisten fehlen. Ob ⌘B/⌘I im WebView greifen: *unverifiziert*.
- **So macht es macOS:** Format > Fett/Kursiv/Unterstrichen + Absatzstile mit ⌘B/⌘I/⌘U.
- **Fix:** `UIMenuFormat`-Befehle ergänzen, die `VeyraNMacMenu`-Kommandos an den Editor senden. *Laufzeit unverifiziert.*
- [ ] erledigt

#### E4

- **Prio:** P1 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 4. Editor
- **Befund:** Kein Suchen/Ersetzen in der Notiz: nur "Find in Notes" (⌘⇧F, `AppDelegate.mm:279-291`) und ein Toolbar-Eintrag `startSearch()` (`editor-mobile/src/components/header.tsx:393`). Ersetzen existiert (`packages/editor/src/toolbar/popups/search-replace.tsx`), aber ohne Shortcut.
- **So macht es macOS:** ⌘F suchen, ⌘⌥F Suchen & Ersetzen, ↩/⇧↩ navigieren.
- **Fix:** Edit-Menü Find/Find & Replace → Editor-Commands, `Cmd-F`-Keymap im WebView.
- [ ] erledigt

#### K2

- **Prio:** P1 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 5. Menüs & Tastatur
- **Befund:** Format-Menü nicht abgedeckt. Siehe E3.
- **So macht es macOS:** Format-Menü für Text.
- **Fix:** Siehe E3.
- [ ] erledigt

#### K3

- **Prio:** P1 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 5. Menüs & Tastatur
- **Befund:** Keine Suchen/Ersetzen-Kürzel im Edit-Menü. Siehe E4.
- **So macht es macOS:** ⌘F / ⌘⌥F.
- **Fix:** Siehe E4.
- [ ] erledigt

#### E2

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 4. Editor
- **Befund:** Titel 25 pt hartkodiert, keine Mac-Größe: `title.tsx:97,119`.
- **So macht es macOS:** Mac-Titel ~17-22 pt (oder im Fenstertitel).
- **Fix:** Mac-Titelgröße über `settings.isMacCatalyst`.
- [ ] erledigt

#### E7

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 4. Editor
- **Befund:** Kein Drag&Drop von Dateien/Bildern in den Editor: kein `onDrop`/`dragOver` (Grep: 0).
- **So macht es macOS:** Bilder/Dateien ziehen, Vorschau, Drop-Ziel.
- **Fix:** DnD-Handler im WebView + `EditorEvents.attachment`.
- [ ] erledigt

#### R6 — Formatleiste im Web-Stil

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [01-main-dark.png](../screenshots/01-main-dark.png)
- **Befund:** Schrittregler „16px“, Dropdowns „Paragraph“ und „Sans-serif“, zwei ⋮-Menüs.
- **Fix:** Wie Notes: ein „Aa“-Knopf in der Toolbar mit Popover (Titel, Überschrift, Text, Listen) plus vollständiges Format-Menü. Keine Pixelangaben in der Oberfläche.
- [ ] erledigt

#### R7 — Editor ohne Textspalte

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [01-main-dark.png](../screenshots/01-main-dark.png)
- **Befund:** Text klebt links an der Spalte. „6 words“ und „Add tag“ stehen als eigene Inhaltszeile über dem Titel.
- **Fix:** Zentrierte Textspalte mit max. ca. 700 pt (E1). Wortzahl in die Statusanzeige oder ins Info-Popover, Tags unter den Text.
- [ ] erledigt

#### E9

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 4. Editor
- **Befund:** Rechtschreibprüfung vorhanden (`editor.tsx:487`), Textsubstitutionen/Datenprüfer nicht erkennbar.
- **So macht es macOS:** macOS-Substitutionen greifen im Textfeld.
- **Fix:** `WKWebView`-Konfiguration prüfen. *unverifiziert.*
- [ ] erledigt

## Regeln für jedes Paket

- Lies zuerst [`../CONTEXT.md`](../CONTEXT.md) (Build, Prüfung, Fallstricke, Git-Regeln).
- Nur Mac-Catalyst-Pfade ändern: `isMacCatalyst()` in JS, `#if TARGET_OS_MACCATALYST` bzw. `targetEnvironment(macCatalyst)` nativ. iPhone und iPad dürfen sich nicht verändern. Android ignorieren.
- Belege mit `datei:zeile` stammen aus dem Code-Audit vom 1. Okt. 2026. Zeilen können sich verschoben haben, also vor dem Ändern nachlesen.
- Kein Computer Use und keine Desktop-Screenshots. Prüfen nur mit `tools/mac-app.sh` (App im Hintergrund, nur App-Fenster). Neue Screenshots als `screenshots/<WPxx>-after-<name>.png` ablegen.
- Am Ende: Checkboxen in dieser Datei und die Statuszeile in [`../PLAN.md`](../PLAN.md) aktualisieren und ein kurzes Ergebnis unter „Ergebnis“ eintragen.

## Ergebnis

_(nach Abschluss ausfüllen: was geändert wurde, Commits, offene Punkte)_
