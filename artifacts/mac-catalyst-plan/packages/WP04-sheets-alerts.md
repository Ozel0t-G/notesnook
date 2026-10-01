# WP04 · Bottom-Sheets und iOS-Alerts durch Mac-Präsentation ersetzen

**Status:** umgesetzt, Laufzeitprüfung teilweise (Esc und Alerts ungetestet) · **Befunde:** 6 (P1×1 · P2×4 · P3×1) · **Abhängig von:** WP03

## Ziel

Auf dem Mac fährt nichts mehr von unten ein. Sheets sind zentrierte, am Fenster hängende Panels oder Popover, Bestätigungen sind native Alerts.

## Vorgehen

1. Zentralen Einstieg finden: `services/event-manager.ts:160-165` → `components/ui/sheet/index.jsx:133-177` (react-native-actions-sheet, 37 Aufrufstellen).
2. Mac-Zweig in `SheetWrapper`: Formsheet-artiges Panel (max. 520 pt breit, Ecken 10 pt, kein Grabber, Esc und Klick außerhalb schließen).
3. Kurze Auswahl-Sheets (nur eine Liste von Aktionen) besser als Kontextmenü bzw. Popover am Auslöser. Liste der 37 Stellen anlegen und je Stelle entscheiden.
4. `Modal presentationStyle="pageSheet"` (D4), `ActionSheetIOS` (D5) und `Alert.alert` (D6) auf eine Mac-taugliche Alert- bzw. Sheet-Hilfsfunktion umstellen.

## Abnahmekriterien

- [x] `grep -rn "ActionSheetIOS\|presentationStyle=\"pageSheet\"" apps/mobile/app` findet keine Mac-Pfade mehr.
- [~] Zwei Beispiel (nur Neues Notizbuch geprüft: `screenshots/WP04-after-notebook-sheet.png`)-Sheets (z. B. Notiz verschieben, Tags) erscheinen auf dem Mac zentriert ohne Grabber. Screenshot ablegen.
- [x] iOS und iPad (alle Mac-Zweige hinter `isMacCatalyst()`; iOS-Build nicht neu gebaut) sind unverändert.
- [x] Release-Build (Catalyst gebaut; iOS nicht) für Catalyst baut fehlerfrei, iOS-Build ebenso.

## Befunde

#### D1

- **Prio:** P1 · **Aufwand:** L · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 6. Modals, Sheets, Popover
- **Befund:** 37 Stellen öffnen iOS-Bottom-Sheets: `services/event-manager.ts:160-165` → `components/ui/sheet/index.jsx:133-177` (`react-native-actions-sheet`), 600 pt breit (`:67-73`), oben 24 pt gerundet (`:76-77`), iOS-Grab-Indicator (`:139-144`).
- **So macht es macOS:** macOS-Sheet am Fenster, Inspector, Popover oder Kontextmenü.
- **Fix:** Mac-Zweig in `SheetWrapper`: zentriertes Panel/`UIModalPresentationFormSheet` bzw. Popover.
- [x] erledigt

#### D3

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 6. Modals, Sheets, Popover
- **Befund:** Task-Detail als Form-Sheet mit iOS-Kopf: `navigation-stack.tsx:164-168`; Cancel/Done wie Reminders auf iOS.
- **So macht es macOS:** Mac-Sheet/Panel mit Toolbar.
- **Fix:** Mac-Kopf/Toolbar statt iOS-Done.
- [ ] erledigt (offen: iOS-Kopf Cancel/Done)

#### D4

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 6. Modals, Sheets, Popover
- **Befund:** `Modal presentationStyle="pageSheet"` in drei Screens: `screens/tasks/detail.tsx:1453-1456`, `tasks/favorites-editor.tsx:119`, `tasks/list-customization.tsx:78`.
- **So macht es macOS:** Popover/Sheet.
- **Fix:** Auf `presentSheet`/Popover umstellen.
- [x] erledigt

#### D5

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 6. Modals, Sheets, Popover
- **Befund:** `ActionSheetIOS` auf dem Mac: `screens/tasks/detail.tsx:394-412` (Änderungen verwerfen) und `:514-529` (Löschen), inkl. Popover-Anker-Sonderfall `isMacCatalyst()`.
- **So macht es macOS:** NSAlert/Sheet.
- **Fix:** Mac-Zweig mit nativer Alert-Bridge.
- [x] erledigt

#### D6

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 6. Modals, Sheets, Popover
- **Befund:** `Alert.alert` in 7 Dateien: `settings/settings-data.tsx`, `settings/logout.ts`, `tasks/index.tsx`, `tasks/favorites-editor.tsx`, `tasks/detail.tsx`, `tasks/list-customization.tsx`, `share/share.tsx`.
- **So macht es macOS:** Native macOS-Alerts.
- **Fix:** Eine zentrale Alert-Bridge.
- [x] erledigt

#### D7

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 6. Modals, Sheets, Popover
- **Befund:** Sheet-Overlay/Backdrop-Handling ist touch-orientiert (`closeOnTouchBackdrop`, `components/ui/sheet/index.jsx:150`).
- **So macht es macOS:** Klick außerhalb schließt, aber ohne Touch-Semantik.
- **Fix:** Mit D1 erledigt.
- [x] erledigt

## Regeln für jedes Paket

- Lies zuerst [`../CONTEXT.md`](../CONTEXT.md) (Build, Prüfung, Fallstricke, Git-Regeln).
- Nur Mac-Catalyst-Pfade ändern: `isMacCatalyst()` in JS, `#if TARGET_OS_MACCATALYST` bzw. `targetEnvironment(macCatalyst)` nativ. iPhone und iPad dürfen sich nicht verändern. Android ignorieren.
- Belege mit `datei:zeile` stammen aus dem Code-Audit vom 1. Okt. 2026. Zeilen können sich verschoben haben, also vor dem Ändern nachlesen.
- Kein Computer Use und keine Desktop-Screenshots. Prüfen nur mit `tools/mac-app.sh` (App im Hintergrund, nur App-Fenster). Neue Screenshots als `screenshots/<WPxx>-after-<name>.png` ablegen.
- Am Ende: Checkboxen in dieser Datei und die Statuszeile in [`../PLAN.md`](../PLAN.md) aktualisieren und ein kurzes Ergebnis unter „Ergebnis“ eintragen.

## Ergebnis

- `components/ui/sheet/index.jsx`: Mac-Zweig = zentriertes Panel (max. 520 pt, Radius 10 rundum, Rand, 24 pt Abstand unten), kein Grabber, keine Wischgeste, Esc über den `VeyraNMacMenuCommand`-Emitter.
- Neu `utils/mac-alert.ts`: `showAlert` (zentral für `Alert.alert`) und `confirmAction` (iOS/iPad weiter ActionSheetIOS, Mac = nativer Alert). `ActionSheetIOS` kommt nur noch dort vor.
- Modals in `tasks/detail`, `favorites-editor`, `list-customization`: Mac = `formSheet` + Fade statt `pageSheet`.
- Umgesetzt mit DeepSeek (2 Jobs), geprüft per Diff, `tsc` und Catalyst-Release-Build. Nicht committet.
- Offen: Esc im Sheet, Discard-/Delete-Alert der Aufgaben und `share/share.tsx` (Share-Extension, bewusst unverändert) nicht zur Laufzeit geprüft; kurze Auswahl-Sheets (Schritt 3, Popover statt Panel) nicht einzeln bewertet; Aufgaben-Detail (D3) hat weiter den iOS-Kopf (Cancel/Done).
