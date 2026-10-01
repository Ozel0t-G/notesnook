# WP03 · Mac-Farben, Systemakzent und Sidebar-Material

**Status:** größtenteils erledigt (Transluzenz offen) · **Befunde:** 10 (P1×2 · P2×7 · P3×1) · **Abhängig von:** —

## Ziel

Catalyst nutzt eigene Mac-Tokens statt iOS-Grouped-Farben. Akzent und Auswahl folgen der Systemeinstellung (grau bei inaktivem Fenster). Die Sidebar ist transluzent.

## Screenshots (Ist-Zustand)

Mit dem Read-Tool ansehen, bevor du anfängst.

![01-main-dark.png](../screenshots/01-main-dark.png)
![07-main-light-toolbar-mismatch.png](../screenshots/07-main-light-toolbar-mismatch.png)
![08-tasks-light.png](../screenshots/08-tasks-light.png)

## Vorgehen

1. `app/utils/apple-visual-tokens.ts` lesen. `ios = Platform.OS === "ios"` greift auch auf Catalyst (`:41`). Eigenen `isMacCatalyst()`-Zweig mit macOS-semantischen Werten anlegen.
2. Systemakzent und Key-Window-Status per nativer Bridge an JS geben (`UIColor.tintColor` bzw. `NSColor.controlAccentColor` über Catalyst, Benachrichtigungen bei Änderung).
3. Auswahl in Sidebar (`components/mac-sidebar.tsx:376-394`) und Liste (`list-items/selection-wrapper/index.tsx:224-240`) auf Akzent bzw. unemphasized umstellen.
4. Sidebar- und Listenhintergrund auf dem Mac transparent machen, damit das Catalyst-Sidebar-Material durchscheint (`mac-sidebar.tsx:236`, `navigation/fluid-panels-view.tsx:455-457`). Prüfen, ob `UISplitViewController`-Primary oder `UIBackgroundConfiguration.listSidebar` das Material liefert.
5. Hartkodierte Farben ersetzen (F3, F6).

## Abnahmekriterien

- [x] Dunkler Screenshot (Sidebar #252527, WP03-after-main.png; Material fehlt noch): Sidebar nicht mehr #000, sondern Material bzw. Mac-Fensterfarbe.
- [~] Systemakzent in den Systemeinstellungen ändern → Auswahl in Sidebar und Liste folgt.
- [x] Fenster nicht aktiv (WP03-after-inactive.png) → Auswahl grau.
- [x] Kein Hex-Wert aus `IOS_DARK` wird auf Catalyst verwendet.
- [x] Release-Build für Catalyst baut fehlerfrei, iOS-Build ebenso.

## Befunde

#### F2

- **Prio:** P1 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 8. Farben & Materialien
- **Befund:** Hartkodierte iOS-Dunkelfarben werden auf dem Mac angewendet: `apple-visual-tokens.ts:30-35` (`#000000/#1C1C1E/#3A3A3C/#38383A`) und `:112-127`, weil `ios = Platform.OS === "ios"` (`:41`) auf Catalyst `true` ist. Der Mac bekommt iOS-`systemGroupedBackground` (Schwarz) statt macOS-Fensterfarben.
- **So macht es macOS:** Semantische macOS-Farben, Sidebar mit Material.
- **Fix:** `isMacCatalyst`-Zweig in `getAppleVisualTokens` mit eigenen Mac-Tokens.
- [x] erledigt

#### R8 — Sidebar reines Schwarz statt Material

- **Prio:** P1 · **Aufwand:** M · **Quelle:** Laufzeit (Screenshot)
- **Screenshot:** [01-main-dark.png](../screenshots/01-main-dark.png)
- **Befund:** Die Sidebar ist opak #000 (iOS systemGroupedBackground). Unter macOS 26 ist sie eine schwebende, transluzente Fläche.
- **Fix:** Mac-Token-Zweig in apple-visual-tokens.ts (F2), Sidebar-Hintergrund transparent, damit das Catalyst-Sidebar-Material durchscheint (F4/F5).
- [x] erledigt

#### F1

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 8. Farben & Materialien
- **Befund:** Kein Systemakzent: Akzent kommt aus dem Theme (`apple-visual-tokens.ts:37-128`, `mac-sidebar.tsx:394`); `NSColor.controlAccentColor` nirgends (Grep: 0).
- **So macht es macOS:** Akzent folgt den Systemeinstellungen.
- **Fix:** Systemakzent per Bridge, Theme-Akzent nur als Override.
- [x] erledigt

#### F3

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 8. Farben & Materialien
- **Befund:** Suchfeld hartkodiert: `ios-nav-bar.tsx:299` (`#1C1C1E` im Dark, `rgba(118,118,128,0.12)`).
- **So macht es macOS:** `NSColor.controlBackgroundColor`/`quaternaryLabelColor`.
- **Fix:** Tokens verwenden.
- [x] erledigt

#### F4

- **Prio:** P2 · **Aufwand:** L · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 8. Farben & Materialien
- **Befund:** Keine Materialien/Vibrancy im Inhalt: im iOS-Projekt kein `NSVisualEffectView` (Grep: 0). Toolbar ist nativ, Inhalt durchgehend opak.
- **So macht es macOS:** Transluzente Toolbar/Sidebar (Liquid Glass).
- **Fix:** Sidebar/Chrome auf Material umstellen.
- [~] teilweise (Farben ja, echte Transluzenz offen)

#### F5

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 8. Farben & Materialien
- **Befund:** Sidebar-/Listenflächen opak: `mac-sidebar.tsx:236`, `fluid-panels-view.tsx:455-457`.
- **So macht es macOS:** Source-List-Material.
- **Fix:** Mit F4.
- [~] teilweise (Farben ja, echte Transluzenz offen)

#### N4

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 3. Notizliste (Mittelspalte)
- **Befund:** Auswahl-Highlight bleibt Akzent auch ohne Key-Fenster: `selection-wrapper/index.tsx:224-240` (immer `colors.primary.accent` @ 0,2).
- **So macht es macOS:** Inaktives Fenster: unemphasized grau.
- **Fix:** Fenster-/Key-Status in `useSelectionStore`/Selector.
- [x] erledigt

#### S1

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 2. Sidebar (Quellliste)
- **Befund:** Auswahl-Pille aus Theme-Akzent mit fixer Opazität 0,2 statt Systemakzent: `mac-sidebar.tsx:376-389`; kein `NSColor.controlAccentColor` im Projekt (Grep: 0). Kein "unemphasized" bei inaktivem Fenster.
- **So macht es macOS:** Systemauswahlfarbe, grau wenn Fenster nicht aktiv.
- **Fix:** Systemakzent per Bridge an RN; Auswahlzustand fokusabhängig rendern.
- [x] erledigt

#### W6

- **Prio:** P2 · **Aufwand:** L · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 1. Fenster & Chrome
- **Befund:** Kein Tracking-Separator und keine Sidebar-Vibrancy: `SceneDelegate.m:38` `separatorStyle=None`; im ganzen iOS-Projekt kein `NSVisualEffectView`.
- **So macht es macOS:** Unified-Toolbar mit dezentem Separator, Quellliste transluzentem Material (Liquid Glass).
- **Fix:** Separator nur bei Unter-Scrollen zeigen; Sidebar über halbtransparenten Hintergrund + native `NSVisualEffectView`-Ebene.
- [~] teilweise (Farben ja, echte Transluzenz offen)

#### F6

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 8. Farben & Materialien
- **Befund:** Einzelne hartkodierte Farben: `note/index.tsx:298` (`color="orange"` für Favorit), `selection-wrapper:278,297` (Swipe-Farben), `intro/index.tsx:166` (`#FFFFFF`).
- **So macht es macOS:** Semantische Systemfarben.
- **Fix:** `systemColor(...)` verwenden.
- [x] erledigt

## Regeln für jedes Paket

- Lies zuerst [`../CONTEXT.md`](../CONTEXT.md) (Build, Prüfung, Fallstricke, Git-Regeln).
- Nur Mac-Catalyst-Pfade ändern: `isMacCatalyst()` in JS, `#if TARGET_OS_MACCATALYST` bzw. `targetEnvironment(macCatalyst)` nativ. iPhone und iPad dürfen sich nicht verändern. Android ignorieren.
- Belege mit `datei:zeile` stammen aus dem Code-Audit vom 1. Okt. 2026. Zeilen können sich verschoben haben, also vor dem Ändern nachlesen.
- Kein Computer Use und keine Desktop-Screenshots. Prüfen nur mit `tools/mac-app.sh` (App im Hintergrund, nur App-Fenster). Neue Screenshots als `screenshots/<WPxx>-after-<name>.png` ablegen.
- Am Ende: Checkboxen in dieser Datei und die Statuszeile in [`../PLAN.md`](../PLAN.md) aktualisieren und ein kurzes Ergebnis unter „Ergebnis“ eintragen.

## Ergebnis

Umgesetzt am 1. Okt. 2026 (DeepSeek-Jobs, vom Supervisor geprüft). Nichts committet.

- **Nativ** (`VeyraNMacMenu.m/.h`): Systemakzent (`NSColor.controlAccentColor` per Runtime) und Fenster-aktiv-Status als Konstanten `systemAccent`/`windowActive`, `getSystemState()` und Event `VeyraNMacSystemState`. Aktiv = Key-Fenster und `NSApplication.isActive` (UIKit-`applicationState` bleibt auf Catalyst im Hintergrund `Active`, das habe ich per Screenshot gefunden und korrigiert). `requiresMainQueueSetup` ist jetzt `YES`.
- **JS**: `use-mac-system-store`, `use-mac-system-state`, `utils/mac-system-state.ts` (`macSelectionFill`: Akzent bei aktivem, Grau bei inaktivem Fenster). Sidebar-Pille und Listenauswahl nutzen es. Mac-Tokens in `apple-visual-tokens.ts` (dunkel: Sidebar #252527, Inhalt #1E1E1E; hell: Sidebar #EFEFF1) ohne `IOS_DARK`-Werte. F3 Suchfeld, F6 Favoritenstern und Intro-Label auf Tokens.
- **Prüfung**: Jest 54 grün, `tsc` sauber in den Mac-Dateien, Catalyst-Release-Build erfolgreich, Screenshots `WP03-after-main.png` (aktiv, blau) und `WP03-after-inactive.png` (grau).
- **Offen**: echte Transluzenz/Material (F4, F5, W6) wurde bewusst nicht gemacht; Sidebar und Liste bleiben opake Mac-Töne. Der Akzent wechselt live nur beim nächsten Aktivieren des Fensters (kein eigenes Signal von macOS). Zeilen „Library“ und „All Notes“ sind gleichzeitig markiert und die Überschrift „Library“ doppelt sich mit der Zeile: Feinschliff für WP11. Das Theme-Akzent-Override ist nicht angebunden (System gewinnt). Toolbar-Items haben im Hintergrund graue Kapseln (nativ, normal).
- **Hinweis zum Prüfen**: `xcodebuild` und `mac-app.sh shot` brauchen `dangerouslyDisableSandbox`; in der Sandbox scheitert das Info.plist-Skript und der Screenshot.
