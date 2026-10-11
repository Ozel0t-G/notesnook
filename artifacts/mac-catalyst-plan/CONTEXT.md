# Kontext für die Mac-Catalyst-Arbeit

## Pfade

Repo-Root: `/Users/ozel0t/Notesnook/notesnook`. Kurze Pfade in den Paketen sind relativ zu:

| Kurzpfad beginnt mit | Liegt unter |
|---|---|
| `app/…`, `screens/…`, `components/…`, `hooks/…`, `utils/…`, `services/…`, `navigation/…`, `list-items/…` | `apps/mobile/app/` |
| `ios/Notesnook/…`, `SceneDelegate.m`, `AppDelegate.mm`, `Info.plist`, `VeyraNMacToolbar.m`, `VeyraNMacMenu.m` | `apps/mobile/ios/Notesnook/` (MacMenu-Dateien in `MacMenu/`) |
| `packages/editor-mobile/…`, `packages/editor/…` | Repo-Root |

## Was auf dem Mac schon existiert (Stand Commit 446a38391, Branch `test`)

| Teil | Dateien |
|---|---|
| „Optimize for Mac“-Idiom (UIDeviceFamily 6), eigene Bundle-IDs `com.ozel0t.note.notesnookpencil.mac(.share/.widget)` | pencil/active xcconfig mit `[sdk=macosx*]` |
| Native Unified-NSToolbar, Suche als `NSUIViewToolbarItem` (NSSearchToolbarItem gibt es auf Catalyst nicht) | `ios/Notesnook/MacMenu/VeyraNMacToolbar.m/.h` |
| Menüleiste und Emitter an JS | `ios/Notesnook/AppDelegate.mm:241-386`, `MacMenu/VeyraNMacMenu.m`, `app/hooks/use-mac-menu-commands.ts` |
| Drei-Spalten-Layout | `app/components/mac-sidebar.tsx`, `app/utils/mac-layout.ts`, `app/navigation/fluid-panels-view.tsx`, `navigation-stack.tsx` |
| Hover, Kontextmenüs, Notizbefehle | `app/components/mac-hover.tsx`, `mac-note-commands.tsx`, `VeyraNMenu.swift` |
| Fenster: Mindestgröße 900 × 600, Titel versteckt, kein Separator | `ios/Notesnook/SceneDelegate.m:36-41` |
| Visuelle Tokens (greifen auf Catalyst als „ios“!) | `app/utils/apple-visual-tokens.ts` |
| Mac-Erkennung | `isMacCatalyst()` aus `app/utils/constants.ts:39` |
| Editor (WKWebView, eigenes Bundle) | `packages/editor-mobile/src/…`, Mac-Maße in `packages/editor-mobile/src/utils/mac.ts` |

## Build

Release-Xcode verwenden, nicht die Beta (`xcode-select` zeigt auf die Beta):

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
```

Nach Änderungen am Editor:

```bash
cd /Users/ozel0t/Notesnook/notesnook && npm run tx editor-mobile:build
```

Lokaler Catalyst-Build. Das Ergebnis landet dort, wo `tools/mac-app.sh` es erwartet:

```bash
cd /Users/ozel0t/Notesnook/notesnook/apps/mobile/ios && xcodebuild -workspace Notesnook.xcworkspace -scheme Notesnook -configuration Release -destination 'platform=macOS,variant=Mac Catalyst' -derivedDataPath build/Catalyst -allowProvisioningUpdates build
```

- Nur arm64 (react-native-screens scheitert an x86_64 auf Catalyst). Falls x86_64 mitgebaut wird: `ARCHS=arm64` anhängen.
- Nach jedem `npm install`: `apps/mobile/ios/scripts/libsodium-catalyst.sh` (libsodium hat keine Catalyst-Slice), danach `pod install`.
- Fehler aus der Planungsphase erscheinen nur ohne `-IDEBuildingContinueBuildingAfterErrors`.
- TestFlight-Archiv: `scripts/build-pencil-testflight.sh --mac` (Upload mit `--mac --upload`; nur auf ausdrücklichen Wunsch).
- JS-Logs der laufenden App: `/usr/bin/log stream --predicate 'subsystem == "com.facebook.react.log"'` (das zsh-Builtin `log` überdeckt `/usr/bin/log`).

## Prüfen ohne Computer Use

Der Nutzer arbeitet parallel am Mac. **Keine Desktop-Screenshots, keine Maus- oder Tastatursteuerung.** Ein früherer Desktop-Screenshot hat einmal ein privates Gespräch erfasst. Stattdessen:

```bash
cd /Users/ozel0t/Notesnook/notesnook/artifacts/mac-catalyst-plan
tools/mac-app.sh launch                   # startet im Hintergrund (open -g), stiehlt keinen Fokus
tools/mac-app.sh menu View Tasks          # Menübefehl über die Bedienungshilfen
tools/mac-app.sh dump                     # beschriftete AX-Elemente auflisten
tools/mac-app.sh press "format, Appearance, Forward"   # Element per AX-Label drücken
tools/mac-app.sh size 900 600             # Fenstergröße testen
tools/mac-app.sh shot WP01-after-search   # nur das App-Fenster -> screenshots/
tools/mac-app.sh menus                    # Menüleiste ausgeben
tools/mac-app.sh quit
```

- Screenshots anschließend mit dem Read-Tool ansehen.
- Das Terminal braucht die Rechte Bedienungshilfen und Bildschirmaufnahme (waren am 1. Okt. erteilt).
- Das Fenster ist im Hintergrund nicht aktiv: graue Ampeln, ausgegraute Fenster-Menüpunkte. Das ist normal.
- Sheets ohne Schließen-Knopf lassen sich ohne Esc nicht schließen. Dann `quit` und erneut `launch`.
- Theme-Wechsel zum Testen geht über Settings › Appearance per `press`. Danach wieder auf „Use system theme“ und „Dark mode“ zurückstellen.

## Regeln

- **Branch `test`**, direkt dort arbeiten, keine Nebenbranches. Andere Sessions ändern denselben Baum, also nur eigene Pfade committen.
- Commits nur auf Wunsch. Dann signiert mit temporärer Git-Config: `GIT_CONFIG_GLOBAL=<datei mit user.name=ozel0t, user.email=ozel0t31820@gmail.com> git commit -s`. Betreff z. B. `mobile(ios): …`. Kein Push zu upstream, keine PRs an streetwriters.
- **Android ignorieren** (eingestellt). iOS und iPad dürfen sich durch Mac-Änderungen nicht verändern: Mac-Code hinter `isMacCatalyst()` bzw. `TARGET_OS_MACCATALYST`.
- AlarmKit und ActivityKit: `canImport` ist auf Catalyst true, die Typen fehlen aber. Mit `!targetEnvironment(macCatalyst)` schützen.
- App Group ist im Mac-Profil nicht beschreibbar. Ein Mac-Build-Schritt entfernt `appGroupId` aus der Info.plist, nicht zurückbauen.
- Neue Icon-Namen der MaterialCommunityIcons müssen in `EXTRA_ICON_NAMES` von `apps/mobile/scripts/optimize-fonts.mjs` stehen, sonst erscheint „?“.
- DeepSeek-Modus FORCE für dieses Projekt: Implementierung an DeepSeek delegieren, selbst prüfen und integrieren. DeepSeek-Jobs stoßen oft an `max_turns`. Das `changes.patch` eines gescheiterten Jobs lässt sich mit `git apply` übernehmen.
- Große Architekturentscheidungen (Mehrfenster, Einstellungen-Fenster, Segment-Umbau) vorher mit dem Nutzer abstimmen.
