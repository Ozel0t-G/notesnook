# WP12 · Mehrfenster, Systemintegration, Onboarding

**Status:** offen · **Befunde:** 14 (P1×1 · P2×7 · P3×6) · **Abhängig von:** WP05, WP11

## Ziel

Notizen lassen sich in eigenen Fenstern öffnen, Inhalte per Drag & Drop und Teilen-Menü austauschen, Spotlight findet Notizen, Intro und Login sehen nach Mac aus.

## Vorgehen

1. Mehrszenen aktivieren (`Info.plist:108-124`). Szene pro Notiz mit `NSUserActivity` (W2). Großer Umbau, vorher mit dem Nutzer planen (EnterPlanMode).
2. Teilen-Menü bzw. Services (I2), Drag-out als .md/.txt (I7), Dokumenttypen .md/.txt (I8), Quick Look (I6).
3. Spotlight per CoreSpotlight (I4). Handoff ausgehend (I5). Status-Item optional (I12).
4. Intro- und Login-Screens mit Mac-Variante (O1, O2, C4).
5. App-Store-Prüfung: Entitlements, Hardened Runtime nur für Notarisierung nötig (I9, I10).

## Abnahmekriterien

- [ ] Rechtsklick auf Notiz › „In neuem Fenster öffnen“ öffnet ein zweites Fenster.
- [ ] Notiz aus der Liste in den Finder ziehen erzeugt eine .md-Datei.
- [ ] Release-Build für Catalyst baut fehlerfrei, iOS-Build ebenso.

## Befunde

#### W2

- **Prio:** P1 · **Aufwand:** L · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 1. Fenster & Chrome
- **Befund:** Einfenster-App: `Info.plist:108-124` `UIApplicationSupportsMultipleScenes=false`; Kommentar `VeyraNMacToolbar.m:125-127` ("Catalyst runs a single window here"). Es gibt kein File > Neues Fenster und "Notiz in neuem Fenster".
- **So macht es macOS:** File > New Window (⇧⌘N) und Notiz in neuem Fenster/neuer Szene.
- **Fix:** Mehrszene aktivieren, Szenen-Konfiguration pro Fenster, `requestSceneSessionActivation`; Notiz-ID je Szene. Architektur-Änderung.
- [ ] erledigt

#### C4

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 7. Controls & Typografie
- **Befund:** Intro als iPhone-Willkommensseite (34-pt-Titel, 88-px-Icon, 50-pt-Buttons): `components/intro/index.tsx:91-169`.
- **So macht es macOS:** Schlichtes Mac-Willkommensfenster.
- **Fix:** Mac-Variante des Intro.
- [ ] erledigt

#### I10

- **Prio:** P2 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Sandbox-Entitlements vorhanden und plausibel: `Notesnook-macOS.entitlements:7-22` (App Sandbox, Netzwerk-Client, Fotos, App Group, Keychain). Für Drucken fehlt `com.apple.security.print` (siehe E5).
- **So macht es macOS:** Vollständige Entitlements.
- **Fix:** Entitlement ergänzen.
- [ ] erledigt

#### I2

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Kein Services-/Teilen-Menü: kein `UIActivityViewController`/Services (Grep: 0); `share/share.tsx` nutzt die eigene Share-Extension.
- **So macht es macOS:** "Dienste"- und "Teilen"-Menü, Notiz/Text teilen.
- **Fix:** `UIActivityViewController` im Popover + Services.
- [ ] erledigt

#### I7

- **Prio:** P2 · **Aufwand:** L · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Kein Drag-Out von Notizen als Datei: kein `UIDragInteraction` im App-Code (Grep: 0).
- **So macht es macOS:** Notiz/Notizblock in Finder/Mail ziehen.
- **Fix:** `UIDragInteraction` mit Text/HTML-Item-Provider.
- [ ] erledigt

#### I8

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Nur `.nnbackup` als Dokumenttyp: `Info.plist:16-28`; keine `.md`/`.txt`/`.html`-Zuordnung.
- **So macht es macOS:** Gängige Textformate öffnen/importieren.
- **Fix:** `CFBundleDocumentTypes` + Importpfad.
- [ ] erledigt

#### O1

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 10. Onboarding / Login
- **Befund:** Intro ist eine iPhone-Willkommensseite (zentriert, 88-px-Icon, 34-pt-Titel, 50-pt-Button): `components/intro/index.tsx:43-195`.
- **So macht es macOS:** Schlichtes Mac-Willkommensfenster (Icon, 1-2 Zeilen, "Weiter").
- **Fix:** Mac-Variante des Intro.
- [ ] erledigt

#### O2

- **Prio:** P2 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 10. Onboarding / Login
- **Befund:** Keine Mac-Sonderbehandlung im Auth-Bereich: `isMacCatalyst` kommt in `components/auth/*` nicht vor (Grep: 0 Treffer). Formulare laufen im iOS-Layout.
- **So macht es macOS:** Mac-Formularbreiten/Kontrollen.
- **Fix:** Mac-Zweig in Auth/Login.
- [ ] erledigt

#### I12

- **Prio:** P3 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Keine Menüleisten-Extra/Schnellnotiz-StatusItem (optional).
- **So macht es macOS:** optional.
- **Fix:** `NSStatusItem` + Schnellnotiz.
- [ ] erledigt

#### I4

- **Prio:** P3 · **Aufwand:** L · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Keine Spotlight-Integration: kein CoreSpotlight (Grep: 0).
- **So macht es macOS:** Notizen über Spotlight finden.
- **Fix:** `CSSearchableIndex` für Titel/Tags.
- [ ] erledigt

#### I5

- **Prio:** P3 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Kein (ausgehendes) Handoff: `NSUserActivity` nur eingehend (`SceneDelegate.m:60-66,90-96`), kein `becomeCurrent`.
- **So macht es macOS:** Handoff der offenen Notiz.
- **Fix:** `userActivity.becomeCurrent()`.
- [ ] erledigt

#### I6

- **Prio:** P3 · **Aufwand:** M · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Keine Quick-Look-Vorschau: kein `QLPreview` (Grep: 0).
- **So macht es macOS:** Leertaste zeigt Vorschau von Anhängen/Export.
- **Fix:** QLPreviewPanel.
- [ ] erledigt

#### I9

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 9. Mac-Systemintegration
- **Befund:** Hardened Runtime nicht gesetzt: `ENABLE_HARDENED_RUNTIME` in `apps/mobile/ios` nicht gefunden (Grep: 0).
- **So macht es macOS:** Hardened Runtime ist für Notarisierung außerhalb des App Store nötig. Der Mac App Store verlangt die Sandbox, nicht die Hardened Runtime.
- **Fix:** `ENABLE_HARDENED_RUNTIME=YES` für die macOS-Konfiguration. *unverifiziert, ob extern gesetzt.*
- [ ] erledigt

#### O3

- **Prio:** P3 · **Aufwand:** S · **Quelle:** Code-Audit (DeepSeek) · **Bereich:** 10. Onboarding / Login
- **Befund:** Onboarding/Editor teilen sich Fenstergrößen-Annahmen (kein eigenes Fenster, siehe W2); kein "letzte Sitzung fortsetzen".
- **So macht es macOS:** Fenster-/Sitzungswiederherstellung.
- **Fix:** Mit W1/W2.
- [ ] erledigt

## Regeln für jedes Paket

- Lies zuerst [`../CONTEXT.md`](../CONTEXT.md) (Build, Prüfung, Fallstricke, Git-Regeln).
- Nur Mac-Catalyst-Pfade ändern: `isMacCatalyst()` in JS, `#if TARGET_OS_MACCATALYST` bzw. `targetEnvironment(macCatalyst)` nativ. iPhone und iPad dürfen sich nicht verändern. Android ignorieren.
- Belege mit `datei:zeile` stammen aus dem Code-Audit vom 1. Okt. 2026. Zeilen können sich verschoben haben, also vor dem Ändern nachlesen.
- Kein Computer Use und keine Desktop-Screenshots. Prüfen nur mit `tools/mac-app.sh` (App im Hintergrund, nur App-Fenster). Neue Screenshots als `screenshots/<WPxx>-after-<name>.png` ablegen.
- Am Ende: Checkboxen in dieser Datei und die Statuszeile in [`../PLAN.md`](../PLAN.md) aktualisieren und ein kurzes Ergebnis unter „Ergebnis“ eintragen.

## Ergebnis

_(nach Abschluss ausfüllen: was geändert wurde, Commits, offene Punkte)_
