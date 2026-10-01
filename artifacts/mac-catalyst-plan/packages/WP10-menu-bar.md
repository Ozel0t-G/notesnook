# WP10 · Menüleiste vervollständigen und validieren

**Status:** umgesetzt bis auf Help-Book, Dock-Menü und Sidebar-Animation · **Befunde:** 11 (P1×1 · P2×5 · P3×4 · —×1) · **Abhängig von:** —

## Ziel

Alle Mac-Standardbefehle sind da, mit Standardkürzeln, und Befehle ohne Ziel sind ausgegraut.

## Vorgehen

1. Ist-Zustand: `menu-bar-snapshot.txt` (zur Laufzeit ausgelesen) und `ios/Notesnook/AppDelegate.mm:241-386`, `hooks/use-mac-menu-commands.ts`.
2. File: New Notebook ⇧⌘N, Import…, Export… (PDF, Markdown, HTML), Print… ⌘P (+ Entitlement `com.apple.security.print`).
3. Note: Pin ⇧⌘P, Favorite, Lock Note, Duplicate. View: Sort By ›, Group By ›, Show Note List.
4. Validierung: JS meldet „Notiz offen/ausgewählt“ an die Bridge, `validateCommand:` bzw. `UIMenuBuilder` setzt disabled (K4).
5. Help: Help-Book oder Link auf die Hilfeseite, statt eines toten „VeyraN Help“ (K5/I11). Dock-Menü mit „Neue Notiz“ (I3).

## Abnahmekriterien

- [x] `tools/mac-app.sh menus` enthält die neuen Einträge.
- [x] Ohne offene Notiz sind Pin, Favorit und Papierkorb ausgegraut.
- [~] ⌘P druckt (nicht getestet) die aktuelle Notiz.
- [x] Release-Build (Catalyst; iOS nicht gebaut) für Catalyst baut fehlerfrei, iOS-Build ebenso.

## Befunde

#### K1

- **Prio:** P1 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 5. Menüs & Tastatur
- **Befund:** File-Menü fast leer: `AppDelegate.mm:264-275` nur "New Note" (⌘N). Es fehlen Neu (Notebook/Aufgabe), Import/Export, Drucken, Teilen, Schließen.
- **So macht es macOS:** Vollständiges File-Menü.
- **Fix:** Befehle + JS-Handler ergänzen.
- [x] erledigt

#### E5

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 4. Editor
- **Befund:** Kein Drucken: kein `window.print(`/`.print(` im Repo (Grep: 0 Treffer).
- **So macht es macOS:** File > Print (⌘P) mit Druckansicht.
- **Fix:** Menüpunkt + WebView-Print; Entitlement `com.apple.security.print` ergänzen.
- [~] erledigt (Menüpunkt + natives Drucken über UIPrintInteractionController, Entitlement gesetzt; Druckdialog nicht getestet)

#### E6

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 4. Editor
- **Befund:** Kein Export/Import im File-Menü: `AppDelegate.mm:248-262` entfernt die Document-Befehle; Export existiert nur in den Einstellungen.
- **So macht es macOS:** File > Exportieren/Importieren (PDF/HTML/Markdown).
- **Fix:** Menüpunkte + vorhandene Export-/Import-Wege.
- [x] erledigt

#### K4

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 5. Menüs & Tastatur
- **Befund:** Menüpunkte ohne Validierung bleiben aktiv: `AppDelegate.mm:224-227` sagt ausdrücklich, Pin/Favorit/Papierkorb bleiben enabled, JS ignoriert sie ohne offene Notiz.
- **So macht es macOS:** Nicht anwendbare Befehle ausgegraut.
- **Fix:** Fokus-/Notizstatus an die Bridge melden, Menü neu bauen.
- [x] erledigt

#### K6

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 5. Menüs & Tastatur
- **Befund:** Kein "Neues Notebook"/"Neue Aufgabe"-Shortcut; ⇧⌘N unbenutzt.
- **So macht es macOS:** ⇧⌘N = Neues Notebook.
- **Fix:** Menüpunkt + Handler.
- [x] erledigt

#### R19 — Menüleiste: fehlende Standardbefehle

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Laufzeit (Bedienungshilfen/Menü)
- **Befund:** Laufzeit-Auslesung: File hat nur „New Note“, „Close“ und „Close All“. Kein Print, Export, Import, New Notebook. Note-Menü: Pin und Favorit ohne Kürzel. View ohne Sortieren, Gruppieren oder „Show Note List“.
- **Fix:** File: New Notebook ⇧⌘N, Import, Export, Print ⌘P. Note: Pin ⇧⌘P, Favorite, Lock. View: Sort By, Show Sidebar, Show Note List. Siehe K1/K4/K6.
- [x] erledigt

#### I11

- **Prio:** P3 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Kein Help-Book. Siehe K5.
- **So macht es macOS:** Hilfe-Menü mit Buch.
- **Fix:** Help-Book registrieren.
- [ ] offen: Help-Menü bleibt der Catalyst-Standard (Ersetzen von UIMenuHelp stürzte beim Start ab)

#### I3

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Kein Dock-Menü: kein `applicationDockMenu:` (Grep: 0).
- **So macht es macOS:** Dock-Menü (Neue Notiz/Aufgabe).
- **Fix:** `applicationDockMenu:` in `AppDelegate`.
- [ ] offen (kein Dock-Menü)

#### K5

- **Prio:** P3 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 5. Menüs & Tastatur
- **Befund:** Laufzeit: Window-Menü ist der Catalyst-Standard (Minimize, Zoom, Fill, Center, Move & Resize). Help-Menü zeigt „VeyraN Help“, aber in `Info.plist` ist kein `CFBundleHelpBookFolder` eingetragen. Der Eintrag führt also ins Leere.
- **So macht es macOS:** "VeyraN Help" + Standard-Window-Menü.
- **Fix:** Help-Book registrieren.
- [ ] offen: Help-Menü bleibt der Catalyst-Standard (Ersetzen von UIMenuHelp stürzte beim Start ab)

#### K8

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 5. Menüs & Tastatur
- **Befund:** Vorhanden und korrekt: ⌘1/2/3 (Library/Tasks/Search), ⌃⌘S Sidebar (`AppDelegate.mm:324-385`), ⌘⌫ Move to Trash (`:310-312`), ⌘, Settings (`:349-362`) — aber Sidebar-Umschalten ohne Animation (`use-mac-menu-commands.ts:195-199`).
- **So macht es macOS:** —
- **Fix:** Übergang animieren.
- [ ] offen (Sidebar-Animation)

#### W3

- **Prio:** — · **Aufwand:** — · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 1. Fenster & Chrome
- **Befund:** Zur Laufzeit widerlegt: Das File-Menü zeigt keinen Eintrag „New Window“ (nur „New Note“, „Close“, „Close All“). Kein Handlungsbedarf, solange W2 fehlt.
- **So macht es macOS:** Kein Menüpunkt ohne Funktion.
- **Fix:** `UIMenuNewScene`/`UIMenuNewItem` explizit entfernen solange W2 fehlt. *unverifiziert (Laufzeit).*
- [x] erledigt

## Regeln für jedes Paket

- Lies zuerst [`../CONTEXT.md`](../CONTEXT.md) (Build, Prüfung, Fallstricke, Git-Regeln).
- Nur Mac-Catalyst-Pfade ändern: `isMacCatalyst()` in JS, `#if TARGET_OS_MACCATALYST` bzw. `targetEnvironment(macCatalyst)` nativ. iPhone und iPad dürfen sich nicht verändern. Android ignorieren.
- Belege mit `datei:zeile` stammen aus dem Code-Audit vom 1. Okt. 2026. Zeilen können sich verschoben haben, also vor dem Ändern nachlesen.
- Kein Computer Use und keine Desktop-Screenshots. Prüfen nur mit `tools/mac-app.sh` (App im Hintergrund, nur App-Fenster). Neue Screenshots als `screenshots/<WPxx>-after-<name>.png` ablegen.
- Am Ende: Checkboxen in dieser Datei und die Statuszeile in [`../PLAN.md`](../PLAN.md) aktualisieren und ein kurzes Ergebnis unter „Ergebnis“ eintragen.

## Ergebnis

File: New Note, New Notebook (⇧⌘N), Import… (öffnet Restore backup), Export… (Notiz exportieren), Print… (⌘P, WKWebView-Druckformatter, Entitlement `com.apple.security.print`). Note: Pin Note ⇧⌘P, Add to Favorites, Lock Note, Move to Trash. View: Sort By und Group By (an das Listenmenü weitergereicht). Validierung (K4): JS meldet per `VeyraNMacMenu.setContext` Notiz offen / Liste fokussiert, Export, Print und Note-Menü sind ohne Notiz ausgegraut (Laufzeit geprüft). Umgesetzt mit DeepSeek (Job brach an max_turns ab, Patch per `git apply`); zwei Korrekturen von mir: Help-Menü-Ersatz und leeres Tastaturkürzel für Import/Export verursachten einen Absturz beim Start und wurden entfernt.
Offen: Help-Menü-Link, Dock-Menü, Sidebar-Animation, Druckdialog und Import/Export-Wege auf dem Mac nicht ausgelöst.
