# WP06 · Notizliste: Swipe aus, Kontextmenüs, Zeilenlayout

**Status:** offen · **Befunde:** 8 (P1×1 · P2×3 · P3×3 · —×1) · **Abhängig von:** WP03

## Ziel

Die Liste verhält sich wie in Notes: keine Wischgesten, Zeile mit Titel, Datum (Locale) und Vorschau, Kontextmenüs überall, Zähler in der Sidebar.

## Screenshots (Ist-Zustand)

Mit dem Read-Tool ansehen, bevor du anfängst.

![01-main-dark.png](../screenshots/01-main-dark.png)
![07-main-light-toolbar-mismatch.png](../screenshots/07-main-light-toolbar-mismatch.png)

## Vorgehen

1. `SwipeRow` in `list-items/selection-wrapper/index.tsx:271-304` nur bei `!isMacCatalyst()` verwenden (N1).
2. Datumsformat über Locale bzw. relativ, zweite Zeile mit Vorschautext (`list-items/note/index.tsx`).
3. Auswahl-Checkbox auf dem Mac weg (N8). Sortier- bzw. Gruppenknöpfe am Sektionskopf zeigen (N7) oder ins View-Menü (C10).
4. Kontextmenüs für Sidebar-Ziele und den leeren Listenbereich (C9). Zähler für Favoriten, Archiv und Papierkorb (S2, `hooks/use-library-source-list.ts:56-71`).

## Abnahmekriterien

- [ ] Trackpad-Wischen über eine Zeile löst keine Aktion aus.
- [ ] Zeile zeigt z. B. „Gestern 14:02 · Brot, Milch und Kaffee“.
- [ ] Rechtsklick auf „All Notes“ und auf leere Liste zeigt ein Menü.
- [ ] Release-Build für Catalyst baut fehlerfrei, iOS-Build ebenso.

## Befunde

#### N1

- **Prio:** P1 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Swipe-Actions auf dem Mac aktiv: `list-items/selection-wrapper/index.tsx:110-113` setzt `nativeMenus = Platform.OS === "ios"` (auf Catalyst true) und wickelt Notizen in `SwipeRow` (`:271-304`) → `ReanimatedSwipeable` (`components/swipe-row.tsx:89-106`). Pin/Papierkorb/Notebook per Wischgeste.
- **So macht es macOS:** Mac kennt keine Wisch-Actions; Aktionen über Kontextmenü/Menüleiste.
- **Fix:** `SwipeRow` nur bei `!isMacCatalyst()`; alternativ Hover-Aktionsknopf.
- [ ] erledigt

#### N7

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Gruppen-Header ohne Sortier-/Ansichtsknöpfe: `list-items/headers/section-header.tsx:87-127` (Mac-Zweig endet vor den `IconButton`s). Sortieren nur im "…"-Menü.
- **So macht es macOS:** Sichtbarer Sortier-/Filter-Zugriff am Listenkopf.
- **Fix:** Vorhandene IconButtons im Mac-Zweig zeigen.
- [ ] erledigt

#### R5 — Notizzeile: US-Datum, keine Vorschau, Kachel-Auswahl

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [01-main-dark.png](../screenshots/01-main-dark.png)
- **Befund:** „09/30/2026“ trotz deutschem System. Keine Textvorschau. Die Auswahl ist eine grau-blaue Kachel statt der Akzentfarbe.
- **Fix:** Datum mit dem Gerätelocale formatieren (relativ: „Gestern“, Uhrzeit). Zeile 2 = Datum + erste Textzeile. Auswahl in Systemakzent, grau wenn das Fenster nicht aktiv ist (S1/N4).
- [ ] erledigt

#### S2

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 2. Sidebar (Quellliste)
- **Befund:** Zähler nur für All Notes/Inbox: `hooks/use-library-source-list.ts:56-71` zählt nur `allNotes`/`inbox`.
- **So macht es macOS:** Badges auch für Favoriten, Archiv, Papierkorb.
- **Fix:** Weitere `count()`-Queries ergänzen.
- [ ] erledigt

#### C10

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 7. Controls & Typografie
- **Befund:** Ansicht/Sortieren nur im "…"-Menü, kein Toggle in Toolbar/View-Menü: `list-view-menu.ts:99-108`.
- **So macht es macOS:** View-Menü/Toolbar-Toggle.
- **Fix:** Menüpunkte ergänzen.
- [ ] erledigt

#### C9

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 7. Controls & Typografie
- **Befund:** Rechtsklick-Kontextmenüs vorhanden (`VeyraNMenu.swift:161-226`), aber nur für Notiz-/Notebook-/Tag-Zeilen (`selection-wrapper:257-267`, `mac-sidebar:421-426`). Für Sidebar-Destinationen (All Notes, Favoriten …) und die Note-List-Sektion fehlen Einträge wie "Neue Notiz", "Sortieren".
- **So macht es macOS:** Kontextmenü überall, wo es Aktionen gibt.
- **Fix:** Kontextmenüs ergänzen.
- [ ] erledigt

#### N8

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Auswahl-Checkbox 35×35 (Touch): `list-items/note/index.tsx:463-476`.
- **So macht es macOS:** Mac listet Auswahl als Highlight, keine Checkboxen.
- **Fix:** Checkbox auf Mac weglassen.
- [ ] erledigt

#### N9

- **Prio:** — · **Aufwand:** — · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Dichte/Typografie passt: 28-pt-Zeilen (`selection-wrapper:45-47`), 13/12 pt (`note/index.tsx:67-68`), Hairline-Separator (`selection-wrapper:209-213`). Positiv.
- **So macht es macOS:** —
- **Fix:** —
- [ ] erledigt

## Regeln für jedes Paket

- Lies zuerst [`../CONTEXT.md`](../CONTEXT.md) (Build, Prüfung, Fallstricke, Git-Regeln).
- Nur Mac-Catalyst-Pfade ändern: `isMacCatalyst()` in JS, `#if TARGET_OS_MACCATALYST` bzw. `targetEnvironment(macCatalyst)` nativ. iPhone und iPad dürfen sich nicht verändern. Android ignorieren.
- Belege mit `datei:zeile` stammen aus dem Code-Audit vom 1. Okt. 2026. Zeilen können sich verschoben haben, also vor dem Ändern nachlesen.
- Kein Computer Use und keine Desktop-Screenshots. Prüfen nur mit `tools/mac-app.sh` (App im Hintergrund, nur App-Fenster). Neue Screenshots als `screenshots/<WPxx>-after-<name>.png` ablegen.
- Am Ende: Checkboxen in dieser Datei und die Statuszeile in [`../PLAN.md`](../PLAN.md) aktualisieren und ein kurzes Ergebnis unter „Ergebnis“ eintragen.

## Ergebnis

_(nach Abschluss ausfüllen: was geändert wurde, Commits, offene Punkte)_
