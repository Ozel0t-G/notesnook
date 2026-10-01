# WP06 · Notizliste: Swipe aus, Kontextmenüs, Zeilenlayout

**Status:** umgesetzt, Catalyst-Build und Sichtprüfung ok; Rechtsklick- und Swipe-Verhalten ungeprüft (N1, N7, N8, S2, C9, C10, R5-Datum/Vorschau) · **Befunde:** 8 (P1×1 · P2×3 · P3×3 · —×1) · **Abhängig von:** WP03

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

- [x] Trackpad-Wischen über eine Zeile löst keine Aktion aus. (N1, Teil A; ohne Build/Screenshot ungeprüft)
- [x] Zeile zeigt z. B. „Gestern 14:02 · Brot, Milch und Kaffee“. (R5, Teil A; ohne Screenshot ungeprüft)
- [x] Rechtsklick auf „All Notes“ und auf leere Liste zeigt ein Menü. (C9; ohne Laufzeitprüfung)
- [x] Release-Build für Catalyst baut fehlerfrei (iOS nicht gebaut). Screenshot WP06-after-list.png: Zähler, Sortier-/Ansichtsknöpfe, keine Checkboxen.

## Befunde

#### N1

- **Prio:** P1 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Swipe-Actions auf dem Mac aktiv: `list-items/selection-wrapper/index.tsx:110-113` setzt `nativeMenus = Platform.OS === "ios"` (auf Catalyst true) und wickelt Notizen in `SwipeRow` (`:271-304`) → `ReanimatedSwipeable` (`components/swipe-row.tsx:89-106`). Pin/Papierkorb/Notebook per Wischgeste.
- **So macht es macOS:** Mac kennt keine Wisch-Actions; Aktionen über Kontextmenü/Menüleiste.
- **Fix:** `SwipeRow` nur bei `!isMacCatalyst()`; alternativ Hover-Aktionsknopf.
- [x] erledigt

#### N7

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Gruppen-Header ohne Sortier-/Ansichtsknöpfe: `list-items/headers/section-header.tsx:87-127` (Mac-Zweig endet vor den `IconButton`s). Sortieren nur im "…"-Menü.
- **So macht es macOS:** Sichtbarer Sortier-/Filter-Zugriff am Listenkopf.
- **Fix:** Vorhandene IconButtons im Mac-Zweig zeigen.
- [x] erledigt — der Mac-Zweig von `list-items/headers/section-header.tsx` zeigt für `index === 0` dieselben Sortier-/Ansichtsknöpfe wie iPhone/iPad (Sort-Sheet via `presentSheet`, Listenmodus via `SettingsService`); die Knöpfe sind als ein `sortAndViewButtons`-Element geteilt, kein neuer Handler.

#### R5 — Notizzeile: US-Datum, keine Vorschau, Kachel-Auswahl

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [01-main-dark.png](../screenshots/01-main-dark.png)
- **Befund:** „09/30/2026“ trotz deutschem System. Keine Textvorschau. Die Auswahl ist eine grau-blaue Kachel statt der Akzentfarbe.
- **Fix:** Datum mit dem Gerätelocale formatieren (relativ: „Gestern“, Uhrzeit). Zeile 2 = Datum + erste Textzeile. Auswahl in Systemakzent, grau wenn das Fenster nicht aktiv ist (S1/N4).
- [~] erledigt — Datum (Locale/relativ) und Zeile-2-Vorschau umgesetzt (`utils/mac-note-date.ts`, `list-items/note/index.tsx`); Systemakzent-Highlight statt Kachel kommt aus dem vorhandenen Mac-Zeilen-Highlight (N4), in diesem Job nicht per Build/Screenshot geprüft.

#### S2

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 2. Sidebar (Quellliste)
- **Befund:** Zähler nur für All Notes/Inbox: `hooks/use-library-source-list.ts:56-71` zählt nur `allNotes`/`inbox`.
- **So macht es macOS:** Badges auch für Favoriten, Archiv, Papierkorb.
- **Fix:** Weitere `count()`-Queries ergänzen.
- [x] erledigt — `hooks/use-library-source-list.ts` zählt zusätzlich `db.notes.favorites.count()`, `db.notes.archived.count()` und `db.trash.count()` (Notizen + Notizbücher aus dem Trash-Cache); `components/mac-sidebar.tsx` zeigt sie an Favoriten/Archiv/Papierkorb. Die bestehenden `databaseUpdated`-Events (notes/notebooks/relations/tags) und `syncCompleted` halten sie weiter aktuell; die iPad-Quellliste nutzt nur All Notes/Inbox und bleibt unverändert.

#### C10

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 7. Controls & Typografie
- **Befund:** Ansicht/Sortieren nur im "…"-Menü, kein Toggle in Toolbar/View-Menü: `list-view-menu.ts:99-108`.
- **So macht es macOS:** View-Menü/Toolbar-Toggle.
- **Fix:** Menüpunkte ergänzen.
- [x] erledigt — Sortieren/Ansicht sind jetzt direkt am Listenkopf sichtbar (N7). Das `listOptions`-Menü (Toolbar/View) und der View-Menüpunkt „Sort By“ bestanden bereits; die neuen Kopf-Knöpfe nutzen dieselben bestehenden Handler, kein Duplikat.

#### C9

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 7. Controls & Typografie
- **Befund:** Rechtsklick-Kontextmenüs vorhanden (`VeyraNMenu.swift:161-226`), aber nur für Notiz-/Notebook-/Tag-Zeilen (`selection-wrapper:257-267`, `mac-sidebar:421-426`). Für Sidebar-Destinationen (All Notes, Favoriten …) und die Note-List-Sektion fehlen Einträge wie "Neue Notiz", "Sortieren".
- **So macht es macOS:** Kontextmenü überall, wo es Aktionen gibt.
- **Fix:** Kontextmenüs ergänzen.
- [x] erledigt — `components/mac-sidebar.tsx` gibt den Bibliotheks-Zielen ein eigenes `ContextMenu`: „New Note“ für All Notes/Inbox (wie Toolbar-Button/⌘N: `setOnFirstSaveUnassigned()` + `openEditor()`), „Empty Trash“ für Papierkorb (vorhandener Bestätigungsdialog, jetzt als `confirmEmptyTrash` aus `screens/trash` exportiert). Publiziert/Monographs bleibt mangels Aktion ohne Menü. Zusätzlich trägt die leere Notizliste (`components/list/index.tsx`, nur Mac Catalyst, kein Sheet, `dataType === "note"`) ein Kontextmenü mit „New Note“ und „Sort By…“, das die vorhandene `showListOptions` (jetzt exportiert) nutzt.

#### N8

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Auswahl-Checkbox 35×35 (Touch): `list-items/note/index.tsx:463-476`.
- **So macht es macOS:** Mac listet Auswahl als Highlight, keine Checkboxen.
- **Fix:** Checkbox auf Mac weglassen.
- [x] erledigt — 35×35-Checkbox nur noch außerhalb von Mac Catalyst; Auswahlpfade (Long-Press, `selectItem`, Zeilen-Highlight) unverändert.

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

Teil A (N1, N8, R5) umgesetzt, alles hinter `isMacCatalyst()`:

- **N1** `list-items/selection-wrapper/index.tsx`: Notizzeilen werden auf Mac Catalyst nicht mehr in `SwipeRow`/`ReanimatedSwipeable` gewickelt (Kontextmenü bleibt); iPhone/iPad unverändert.
- **N8** `list-items/note/index.tsx`: 35×35-Auswahl-Checkbox nur noch außerhalb von Mac Catalyst. Auswahl bleibt über Long-Press/`selectItem` und das Mac-Zeilen-Highlight (N4) funktionsfähig.
- **R5** neu `utils/mac-note-date.ts` mit `formatMacNoteDate(date, now?, locale?)`: „Heute“ bzw. „Gestern“ über `Intl.RelativeTimeFormat({numeric:"auto"})` plus lokalisierte Uhrzeit, ältere Daten als lokales Kurzdatum. Die Mac-Zeile zeigt jetzt genau eine zweite Zeile `Datum · erste Textzeile` aus dem vorhandenen `headline` (keine neue DB-Abfrage). Test `utils/mac-note-date.test.ts` modelliert nach `mac-layout.test.ts`.

Offen in WP06 (nicht in Teil A): N7, C9, S2, C10.

Verifikation: In dieser isolierten Arbeitskopie waren `node_modules` und Netzwerk nicht verfügbar, daher konnten `jest`, `tsc`, `eslint` und `prettier` nicht laufen und es wurde kein Catalyst-Build/Screenshot erstellt. Die reine Helferlogik wurde mit Node gegen die Locale-Erwartungen (en-US/de-DE) geprüft; alle Fälle stimmen. Restliche Prüfung (Build, Screenshot, Lint) steht noch aus.

### Teil B (N7, S2, C10, C9) — umgesetzt, Build/Lint ungeprüft

- **S2** `hooks/use-library-source-list.ts`: `counts` um `favorites`, `archived`, `trash` erweitert (`db.notes.favorites.count()`, `db.notes.archived.count()`, `db.trash.count()` — letzteres synchron aus dem Trash-Cache und damit inkl. Papierkorb-Notizbüchern). `components/mac-sidebar.tsx` bindet sie an Favoriten/Archiv/Papierkorb; die vorhandenen `databaseUpdated`- und `syncCompleted`-Abos halten alles frisch, die iPad-Quellliste unverändert.
- **N7/C10** `list-items/headers/section-header.tsx`: Die vorhandenen Sortier-/Ansichtsknöpfe sind in `sortAndViewButtons` zusammengezogen und werden im Mac-Zweig beim ersten Gruppenkopf (`index === 0`) rechts angezeigt; Handler unverändert (Sort-Sheet via `presentSheet`, Listenmodus via `SettingsService`).
- **C9** `components/mac-sidebar.tsx`: `LibraryDestination` um `menuItems`/`onMenuSelect` erweitert; All Notes/Inbox → „New Note“ (`setOnFirstSaveUnassigned()` + `openEditor()`), Trash → „Empty Trash“ über den aus `screens/trash` exportierten Bestätigungsdialog (`confirmEmptyTrash`). `components/list/index.tsx`: leere Notizliste (Mac Catalyst, `dataType === "note"`, kein Sheet) in ein `ContextMenu` mit „New Note“ und „Sort By…“ gehüllt; „Sort By…“ ruft das jetzt exportierte `showListOptions` (Toolbar-/View-Menü) auf. „Published“ existiert in der Sidebar nur als Monographs-Zeile und bekommt (keine Aktion) kein Menü.

Verifikation Teil B: `node_modules` fehlt weiterhin, daher kein `eslint`/`prettier`/`tsc` und kein Build. Änderungen sind per Hand auf Prettier-Stil (printWidth 80) formatiert; Import-Zyklen wurden geprüft (kein Top-Level-Zyklus). Restliche Prüfung steht aus.

