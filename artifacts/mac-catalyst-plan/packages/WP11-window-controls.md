# WP11 · Fenster-Grundlagen und Mac-Controls

**Status:** Teil A (W1, R10) umgesetzt; Spaltentrenner, Tooltips, Cursor, Sidebar-Baum offen · **Befunde:** 11 (P2×8 · P3×2 · —×1) · **Abhängig von:** WP02

## Ziel

Fenster merkt Größe und Position, Spalten sind ziehbar, die Sidebar klappt bei kleiner Breite ein, Controls haben Mac-Größen, Tooltips und Zeiger-Cursor.

## Screenshots (Ist-Zustand)

Mit dem Read-Tool ansehen, bevor du anfängst.

![09-min-size-900x600.png](../screenshots/09-min-size-900x600.png)

## Vorgehen

1. `ios/Notesnook/SceneDelegate.m:36-41`: Standardgröße, State-Restoration (W1). Toolbar-Anpassung erlauben (W5).
2. Ziehbare Spaltentrenner mit gespeicherter Breite (`utils/mac-layout.ts:101-110`) (W7). Auto-Einklappen unter ca. 1000 pt (R10).
3. Sidebar: Notebook-Baum mit Disclosure, Umbenennen, Drag-Ziel, Tooltips (S3, S4, S6).
4. Mac-Größen-Token statt 44 pt (C1), Hand-Cursor (C6), Tooltips an allen Buttons (C7).

## Abnahmekriterien

- [x] App schließen und wieder öffnen → gleiche Fenstergröße und -position.
- [x] Bei 900 pt Breite ist die Sidebar eingeklappt und der Editor hat ≥ 560 pt.
- [ ] Hover über einen Knopf zeigt nach ca. 1 s einen Tooltip.
- [ ] Release-Build für Catalyst baut fehlerfrei, iOS-Build ebenso.

## Befunde

#### C1

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 7. Controls & Typografie
- **Befund:** 44-pt-Touch-Ziele überall: `ios-nav-bar.tsx:166-172` (`minWidth/minHeight: 44`), `ui/icon-button/index.tsx:96-105` (40×40 + hitSlop 10/30), 17 Stellen mit expliziten 44 pt (Grep).
- **So macht es macOS:** Mac-Controls 20-28 pt, größere Icons sind erlaubt, aber keine 44-pt-Hit-Slops.
- **Fix:** Mac-Größen-Token einführen.
- [ ] erledigt

#### C6

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 7. Controls & Typografie
- **Befund:** Kein Zeiger-Cursor: kein `cursor:`/Pointing-Hand im App-Code (Grep: 0); `Pressable` zeigt den Standardpfeil.
- **So macht es macOS:** Hand-Cursor über Buttons/Links.
- **Fix:** Native `NSCursor.pointingHand` über Hover-Region.
- [ ] erledigt

#### C7

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 7. Controls & Typografie
- **Befund:** Tooltips nur in der NSToolbar: `VeyraNMacToolbar.m:398,454,574`. In-App-Buttons haben nur `accessibilityLabel` (`ios-nav-bar.tsx:162`).
- **So macht es macOS:** Hover-Tooltips an allen Bar-Buttons.
- **Fix:** `toolTip`/`NativeTooltip` ergänzen.
- [ ] erledigt

#### R10 — Formatleiste wird abgeschnitten, Sidebar bleibt stehen

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [09-min-size-900x600.png](../screenshots/09-min-size-900x600.png)
- **Befund:** „Paragraph“ und „Sans-serif“ verschwinden kommentarlos. Die Sidebar klappt nicht automatisch ein.
- **Fix:** Unter ca. 1000 pt die Sidebar automatisch einklappen (wie Notes). Überzählige Toolbar-Items wandern ins »-Überlaufmenü.
- [x] erledigt (unter 1000 pt klappt die Sidebar ein; Screenshot WP11-after-narrow.png)

#### S3

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 2. Sidebar (Quellliste)
- **Befund:** Keine Disclosure/Collapse, keine Unter-Notebooks: `mac-sidebar.tsx:278-299` rendert flache Notebook-Liste.
- **So macht es macOS:** Aufklappbare Dreiecke, verschachtelte Notebooks, gemerkter Zustand.
- **Fix:** Notebook-Baum aus `db.notebooks` + `DisclosureGroup`-Verhalten.
- [ ] erledigt

#### S4

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 2. Sidebar (Quellliste)
- **Befund:** Kein Umbenennen/Drag&Drop/Sortieren in der Sidebar: `mac-sidebar.tsx` hat kein Rename/Drag; nur Kontextmenü für Notebook/Tag-Items (`:421-426`).
- **So macht es macOS:** Umbenennen und Notizen per Drag in Notebooks ziehen.
- **Fix:** Kontextmenü "Umbenennen" + Drag-Ziel über `UIDragInteraction`/RN-Drax.
- [ ] erledigt

#### W1

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 1. Fenster & Chrome
- **Befund:** Nur Mindestgröße, kein Standardmaß, keine Wiederherstellung: `SceneDelegate.m:41` setzt ausschließlich `minimumSize = 900x600`; nirgends `restorationIdentifier`/`stateRestoration` (Grep im iOS-Projekt: 0 Treffer).
- **So macht es macOS:** Fenster öffnet mit sinnvoller Größe, merkt Größe/Position je Sitzung.
- **Fix:** Im `scene:willConnect…` eine `UIWindowSceneGeometryPreferencesMac` mit Default-Größe setzen; State-Restoration über `UISceneDelegate` + `NSUserActivity` ergänzen.
- [x] erledigt (Fenstergröße/-position werden gemerkt, Standard 1200 × 800; nach ⌘Q gleiche Größe geprüft)

#### W7

- **Prio:** P2 · **Aufwand:** L · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 1. Fenster & Chrome
- **Befund:** Feste Spaltenbreiten, nicht ziehbar: `mac-layout.ts:101-110` (Sidebar 200-260, Liste 260-360, aus der Fensterbreite abgeleitet).
- **So macht es macOS:** Ziehbarer Trenner zwischen Sidebar/Liste/Editor, Breite persistiert.
- **Fix:** Split-Handle in RN (Drag gesteuert) oder native `UISplitViewController` mit `preferredPrimaryColumnWidth`.
- [ ] erledigt

#### S6

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 2. Sidebar (Quellliste)
- **Befund:** Keine Tooltips bei abgeschnittenen Namen: `mac-sidebar.tsx:396-406` (`numberOfLines={1}`), kein Tooltip.
- **So macht es macOS:** Hover-Tooltip mit vollem Namen/Notizenzahl.
- **Fix:** `tooltipText` an die Zeile hängen.
- [ ] erledigt

#### W5

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 1. Fenster & Chrome
- **Befund:** Keine Toolbar-Anpassung: `VeyraNMacToolbar.m:166-167` (`displayMode=IconOnly`, `allowsUserCustomization=NO`) und `toolbarAllowedItemIdentifiers` = Default (`:345-350`).
- **So macht es macOS:** NSToolbar konfigurierbar (optional, aber Standard auf dem Mac).
- **Fix:** `allowsUserCustomization=YES`; Flexible-Space/Separator in Allowed aufnehmen.
- [ ] erledigt

#### C8

- **Prio:** — · **Aufwand:** — · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 7. Controls & Typografie
- **Befund:** Hover-Feedback vorhanden: `components/mac-hover.tsx`, eingebaut in Sidebar, Listen, Navbar, IconButton, Menübutton. Positiv.
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

### Ergebnis (Teil A)
W1: `SceneDelegate.m` speichert den Fensterrahmen (`effectiveGeometry.systemFrame`) in NSUserDefaults (bei Geometrieänderung, Deaktivierung und Beenden) und stellt ihn beim Start per `UIWindowSceneGeometryPreferencesMac` wieder her (Standard 1200 × 800, Minimum 900 × 600). R10: `mac-layout.ts` (`macSidebarAutoCollapsed`, `macSidebarEffectiveVisible`, Tests), `use-mac-sidebar-store.ts` (`override`, `useMacSidebarVisible`); Toggle Sidebar überstimmt die Automatik, bis das Fenster den Schwellenwert (1000 pt) wieder kreuzt. W5/W7: nicht umgesetzt. Hinweis: DeepSeek-Worker hing in dieser Phase mehrfach ohne Ausgabe; W1 und R10 habe ich selbst umgesetzt.
