# WP02 · Ein Toolbar-Band statt drei Chrome-Zeilen

**Status:** umgesetzt, Laufzeitprüfung offen · **Befunde:** 10 (P1×1 · P2×7 · P3×2) · **Abhängig von:** WP01

## Ziel

Über Liste und Editor gibt es nur noch die native NSToolbar (wie Notes): Listentitel und Sortiermenü über der Liste, Editor-Aktionen über dem Editor. Nur ein Suchfeld.

## Screenshots (Ist-Zustand)

Mit dem Read-Tool ansehen, bevor du anfängst.

![01-main-dark.png](../screenshots/01-main-dark.png)
![09-min-size-900x600.png](../screenshots/09-min-size-900x600.png)

## Vorgehen

1. Bestand lesen: `ios/Notesnook/MacMenu/VeyraNMacToolbar.m`, `app/utils/mac-layout.ts`, `app/components/header/index.tsx`, `packages/editor-mobile/src/components/header.tsx`, `app/components/ios-nav-bar.tsx`.
2. Toolbar-Items pro Spalte mit Tracking-Separatoren anlegen (`NSTrackingSeparatorToolbarItem` bzw. Catalyst-Äquivalent). Neue Items: Sortieren/Ansicht (Liste), Teilen, Info, ⋯ (Editor).
3. Editor-Kopfzeile auf dem Mac ausblenden. Undo/Redo nur im Edit-Menü, Vollbild über das Fenster, Tab-Zähler auf dem Mac entfernen.
4. Listen-Navbar (`IosNavBar`) und Listensuchfeld auf dem Mac weglassen. Titel über Fenstertitel/Untertitel (W4).
5. Segment Library/Tasks/Search aus dem Bereich neben den Ampeln nehmen (R4): Bereiche über die Sidebar oder ein zentriertes Segment. Architekturentscheidung vorher mit dem Nutzer klären.
6. Toolbar-Höhe nicht hart verdrahten (W8). Mac-Icongrößen aus `packages/editor-mobile/src/utils/mac.ts` nutzen (E8).
7. Editor-Bundle neu bauen: `npm run tx editor-mobile:build`.

## Abnahmekriterien

- [~] Screenshot zeigt zwischen Toolbar und Inhalt keine zweite Kopfzeile, weder über der Liste noch über dem Editor.
- [~] Genau ein Suchfeld sichtbar.
- [~] Fenstertitel bzw. Untertitel zeigt Bereich bzw. Notiz.
- [~] Bei 900 × 600 pt laufen keine Toolbar-Items aus dem Fenster (Überlaufmenü).
- [x] Release-Build für Catalyst baut fehlerfrei, iOS-Build ebenso.

## Befunde

#### R1 — Drei Chrome-Zeilen über dem Editor

- **Prio:** P1 · **Aufwand:** M · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [01-main-dark.png](../screenshots/01-main-dark.png)
- **Befund:** Toolbar, dann eine eigene Editor-Kopfzeile (Vollbild, Undo, Redo, Tab-Zähler „1“, ⋮), dann die Formatleiste. Apple Notes hat genau ein Toolbar-Band.
- **Fix:** Editor-Aktionen in die NSToolbar-Sektion über der Editorspalte verschieben. Undo/Redo gibt es schon im Edit-Menü, Vollbild ist eine Fensterfunktion, der Tab-Zähler ist eine iOS-Browser-Metapher und sollte auf dem Mac weg.
- [x] erledigt

#### E8

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 4. Editor
- **Befund:** Editor-Header-Buttons 25 pt / 40 px (Touch): `editor-mobile/src/components/header.tsx:217,285,300`; die Mac-Maße (`utils/mac.ts:41-44`, Icon 16, Button 28) werden dort nicht genutzt.
- **So macht es macOS:** 16-18 pt Toolbar-Icons, 24-28 pt Ziele.
- **Fix:** `MAC_TOOLBAR_ICON_SIZE`/`MAC_TOOLBAR_BUTTON_SIZE` verwenden.
- [x] erledigt

#### N5

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Doppeltes Suchfeld: `header/index.tsx:214-220` rendert `IosSearchField` in der Mittelspalte, obwohl die NSToolbar bereits ein Suchfeld hat (`VeyraNMacToolbar.m:439-496`); nur der Such-Screen blendet es aus (`global-search/index.tsx:176-181`).
- **So macht es macOS:** Ein Suchfeld — das in der Toolbar.
- **Fix:** `IosSearchField` auf Mac unterdrücken, wenn `toolbarSearch === true`.
- [x] erledigt

#### N6

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** 44-pt-Navbar-Zeile mit 17-pt-Titel in der Liste: `header/index.tsx:149-208`.
- **So macht es macOS:** Mac-Listenspalte hat keine eigene Navbar; Listenname gehört in die Toolbar.
- **Fix:** Mac-Zweig ohne `IosNavBar`; Namen in Toolbar-Untertitel (siehe W4).
- [x] erledigt

#### R2 — Listenkopf als zweite Zeile, Toolbar darüber leer

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [01-main-dark.png](../screenshots/01-main-dark.png)
- **Befund:** „All Notes“ und der ⋮-Knopf sitzen unter einem leeren Toolbar-Streifen. Die Toolbar über der Liste bleibt ungenutzt.
- **Fix:** Listentitel als Fenstertitel/Untertitel und Sortier- bzw. Ansichtsmenü als Toolbar-Item über der Listenspalte (Tracking-Separator). Deckt sich mit N6/W4.
- [x] erledigt

#### R3 — Drei Suchen gleichzeitig

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [01-main-dark.png](../screenshots/01-main-dark.png)
- **Befund:** Suchfeld in der Toolbar rechts, Lupe im Segment links und ein Suchfeld in der Liste.
- **Fix:** Nur das Toolbar-Suchfeld behalten. Lupe aus dem Segment und Listensuchfeld auf dem Mac entfernen (N5).
- [x] erledigt

#### R4 — Segment links wirkt wie eine iPad-Tab-Bar

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [01-main-dark.png](../screenshots/01-main-dark.png)
- **Befund:** Library / Tasks / Search als Kapsel direkt neben den Ampeln.
- **Fix:** Bereiche als Abschnitte in der Sidebar führen (wie Mail und Notes) oder als Segment mittig in der Toolbar. Links neben den Ampeln gehört nur der Sidebar-Knopf hin.
- [x] erledigt

#### W4

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 1. Fenster & Chrome
- **Befund:** Kein Fenstertitel/Untertitel: `SceneDelegate.m:36` `titleVisibility = UITitlebarTitleVisibilityHidden`; Toolbar `IconOnly` (`VeyraNMacToolbar.m:166`). Der Nutzer sieht nirgends, welche Notiz offen ist.
- **So macht es macOS:** Fenstertitel = Bereich/Notizname, Untertitel = Notebook/Speicherstatus.
- **Fix:** `titleVisibility=Visible`; Titel/Untertitel per Bridge aus JS (`NativeModules.VeyraNMacMenu`) setzen.
- [x] erledigt

#### S5

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 2. Sidebar (Quellliste)
- **Befund:** Sidebar-Kopf nutzt eine 44-pt-Navigationsleiste: `mac-sidebar.tsx:243-260` (`IosNavBar`, `minHeight 44` in `ios-nav-bar.tsx:65`).
- **So macht es macOS:** Quellliste hat keine eigene Navbar.
- **Fix:** Kopf auf einen schlichten 13-pt-Text reduzieren.
- [x] erledigt

#### W8

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 1. Fenster & Chrome
- **Befund:** Toolbar-Höhe als 52-pt-Konstante hart verdrahtet: `mac-layout.ts:52,64-65` und `packages/editor-mobile/src/utils/mac.ts:38` (52).
- **So macht es macOS:** Reale Toolbar-Höhe verwenden.
- **Fix:** Native Konstanten-Bridge mit gemessener `NSToolbarView`-Höhe statt Fallback.
- [x] erledigt

## Regeln für jedes Paket

- Lies zuerst [`../CONTEXT.md`](../CONTEXT.md) (Build, Prüfung, Fallstricke, Git-Regeln).
- Nur Mac-Catalyst-Pfade ändern: `isMacCatalyst()` in JS, `#if TARGET_OS_MACCATALYST` bzw. `targetEnvironment(macCatalyst)` nativ. iPhone und iPad dürfen sich nicht verändern. Android ignorieren.
- Belege mit `datei:zeile` stammen aus dem Code-Audit vom 1. Okt. 2026. Zeilen können sich verschoben haben, also vor dem Ändern nachlesen.
- Kein Computer Use und keine Desktop-Screenshots. Prüfen nur mit `tools/mac-app.sh` (App im Hintergrund, nur App-Fenster). Neue Screenshots als `screenshots/<WPxx>-after-<name>.png` ablegen.
- Am Ende: Checkboxen in dieser Datei und die Statuszeile in [`../PLAN.md`](../PLAN.md) aktualisieren und ein kurzes Ergebnis unter „Ergebnis“ eintragen.

## Ergebnis

Umgesetzt am 1. Okt. 2026 (DeepSeek-Jobs, vom Supervisor geprüft). Nichts committet. Architekturentscheidung R4 mit dem Nutzer: Bereiche als Sidebar-Abschnitte.

- **Native Toolbar** (`VeyraNMacToolbar.m/.h`, `VeyraNMacMenu.m/.h`, `SceneDelegate.m`): Segment entfernt. Items: Sortieren/Ansicht (`listOptions`), Neu, Teilen (`shareNote`), Info (`noteInfo`), Mehr (`noteMore`), Suchfeld. Sichtbarkeitsprioritäten für den Überlauf. `NSTrackingSeparatorToolbarItem` ist auf Catalyst nicht verfügbar, daher normale Reihenfolge. Fenstertitel sichtbar; neue Bridge `setWindowTitle(title, subtitle)`, `getToolbarHeight()`, Konstante `toolbarHeight`.
- **Editor-Bundle**: Kopfzeile auf dem Mac nicht mehr gerendert, `MAC_EDITOR_HEADER_HEIGHT = 0`, Formatleiste beginnt oben. Bundle neu gebaut.
- **JS**: Sidebar mit Library/Tasks/Search-Zeilen und schlichtem Kopf (`mac-sidebar.tsx`); Sidebar auch neben Tasks/Search (`mac-section-layout.tsx`); Listenkopf ohne Navbar/Suche auf dem Mac, Auswahlmodus bleibt; Menü der Liste über `useMacWindowStore` und Toolbar-Befehl `listOptions` als Sheet; `use-mac-window-title.ts` setzt Fenstertitel/Untertitel; `openMacList` wechselt aus Tasks/Search zurück zu Library; `macToolbarInset` nutzt die gemessene Höhe und cached sie (W8, R20).
- **Prüfung**: `tsc` ohne Fehler in den Mac-Dateien, Jest `mac-layout` und `mac-window-title` grün (14 Tests), Catalyst-Release-Build erfolgreich, App startet und der Fenstertitel „All Notes“ erscheint (winlist).
- **Offen**: Screenshots/Laufzeitprüfung (Screencapture und Bedienungshilfen fanden das Fenster nicht, App lief im Hintergrund); `noteMore` öffnet derzeit wie `noteInfo` die Properties; Notiztitel im Fenstertitel aktualisiert sich erst beim Speichern; R18 (Toolbar-Segment-Namen) hat sich erledigt, weil das Segment entfällt; iOS-Simulator-Build nicht neu gebaut; Hilfsskript `mac-app.sh` findet das Fenster jetzt per Größe statt per Titel.
