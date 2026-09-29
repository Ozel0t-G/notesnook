# Claude Handoff — VeyraN Urgent Reminders

Stand: 2026-09-29  
Branch: `test`  
Implementierungsstand: `f82bee0b31eb5a8100022a16e96049af65d1b319`  
Handoff-Commit: `988bbb446`  
Basis: `17def76c1e069a72c4b74e9c035a847ff66c286b`

## Auftrag

Zwei bestehende Fehler wurden bearbeitet:

1. Urgent-Erinnerungen verhielten sich wie normale zeitkritische Notifications.
2. Ein Tap auf eine Task-Notification öffnete den Task-Editor statt die aktuelle Task-Liste.

Die Integration ist lokal in `test` erfolgt. Es wurde nichts nach `main` gemergt, gepusht, hochgeladen oder veröffentlicht.

## Umgesetzt

### Urgent-Alarme

- Öffentliche AlarmKit-Integration mit iOS-Verfügbarkeitsprüfung ab iOS 26.
- Autorisierungszustände `authorized`, `denied`, `notDetermined` und `unsupported` werden an JavaScript zurückgegeben.
- AlarmKit wird nur über den expliziten Urgent-Berechtigungsfluss angefragt, nicht aus einer Hintergrund-Reconciliation.
- Normale Erinnerungen behalten ihren normalen Notifee-Timestamp-Notification-Pfad.
- Urgent-Erinnerungen verwenden AlarmKit, wenn es verfügbar und autorisiert ist.
- Bei fehlender Berechtigung oder nicht unterstützter Plattform wird eine klar bezeichnete normale Fallback-Notification verwendet.
- Die Fallback-Notification sagt ausdrücklich, dass kein Alarm verfügbar ist.
- Alarm-IDs sind accountgebunden und pro Occurrence stabil.
- Wiederkehrende Tasks werden pro Occurrence geplant; bis zu fünf kommende RRULE-Occurrencen werden berücksichtigt.
- Alarmzustände werden getrennt vom Task-Zustand behandelt.
- Stop beendet nur die Alarmpräsentation und erledigt den Task nicht.
- Snooze nutzt AlarmKit-Countdown mit neun Minuten `postAlert`; die Task-Occurrence und RRULE werden nicht verändert.
- Completion läuft weiterhin über die autoritative Task-Domain.
- Reschedule, Löschen, Completion, Logout, Accountwechsel und deaktivierte Urgent-Erinnerungen bereinigen die zugehörigen lokalen Alarmzustände.
- Fallbacks werden vor dem Einführen eines neuen Alarms zurückgezogen und ihr Entfernen wird verifiziert.
- Ein unbekannter Reconcile-Ausgang erzeugt keinen zusätzlichen Fallback und verhindert damit doppelte akustische Zustellungen.
- Aktive, pausierte oder gesnoozte Präsentationen werden bei Reconciliation nicht zerstört.
- Die letzten Korrekturen:
  - App-Lock-Fehler beim Entfernen einer unredigierten Präsentation werden ehrlich als gehalten und unredigiert gemeldet.
  - Ein bereits fälliger Alarm wird bei Redaction nicht auf einen vergangenen Zeitpunkt neu geplant.
  - Nach einer Cancellation wird das tatsächliche native Restinventar erneut gelesen; veraltete `owned`, Fingerprint- und Redaction-Einträge werden entfernt.
  - Doppelte native Eingaben verwenden keine abstürzende `uniqueKeysWithValues`-Konstruktion mehr.
  - Partielle Cancellation-Ergebnisse bleiben für einen späteren Retry erhalten.

### Overdue-Darstellung

- ActivityKit-Live-Activities für unvollständige, zeitgebundene Urgent-Tasks.
- Systemformatierter Timer zeigt die verstrichene Überfälligkeit ohne JavaScript-Minuten-Timer.
- App-Lock verwendet für Overdue-Flächen den Platzhalter `VeyraN Task`.
- Maximal fünf gleichzeitige Flächen; Lebensdauer ist auf ungefähr acht Stunden begrenzt.
- Completion, Delete, Reschedule, Entfernung der Erinnerung und Urgent-Deaktivierung beenden die zugehörige Fläche.
- Widget-Snapshot und Live-Activity-Cleanup sind in Logout-/Accountwechsel-Reconciliation einbezogen.
- Cleanup-Fehler werden als minimale, inhaltsfreie Retry-Verpflichtung persistiert und beim nächsten Start/Foreground vor neuer Planung wiederholt.

### Notification-Tap-Navigation

- Gemeinsamer Resolver in `apps/mobile/app/services/task-navigation.ts`.
- Notification-Intents enthalten nur stabile IDs, Account-ID, Occurrence-Key und Quelle; keine Task-Titel oder List-Inhalte.
- Account-Mismatch wird vor dem Lesen der Task-Domain verworfen.
- Bei App Lock, Loading, Logout oder noch nicht initialisierter Domain wird der minimale Intent sicher gepuffert.
- Logout und Accountwechsel leeren den Pending-Intent.
- Der Task wird frisch aus der autoritativen Domain geladen.
- Ein verschobener Task öffnet seine aktuelle kanonische Liste, nicht eine veraltete Payload-Liste.
- Ein erledigter Task bleibt in seinem aktuellen Kontext sichtbar oder fällt auf die Completed-Liste zurück.
- Ein gelöschter Task öffnet einen sicheren Tasks-Zielort mit generischer Meldung.
- Stale wiederkehrende Occurrences werden nicht auf die nächste Occurrence angewendet.
- Mehrere schnelle Taps verwenden Generation-/Nonce-Schutz; der letzte gültige Tap gewinnt.
- Die Task-Liste scrollt den Ziel-Task mit begrenzten Retries in Sicht.
- Der Task erhält für 2,2 Sekunden einen temporären Fokus/Highlight.
- Highlight startet erst, wenn die Zeile tatsächlich sichtbar ist.
- Unmount, Listenänderung und neue Intents brechen alte Scroll-/Highlight-Arbeit ab.
- Kein Notification-Tap öffnet automatisch `TaskDetail`, fokussiert ein Eingabefeld oder öffnet die Tastatur.
- Warm-Start, Cold-Start, Widget-Task-Link, Legacy-Link und Notification-PRESS verwenden diesen Resolver.
- Create-Task-Flows bleiben absichtlich im bestehenden Editorfluss.

### Datenschutz und Datenmodell

- Kein zweiter Task-Speicher.
- Keine parallele Crypto- oder Recurrence-Implementierung.
- Keine Task-Titel in native `UserDefaults`-Metadaten.
- Native Persistenz enthält nur IDs, Fingerprints, Status-/Retry-Metadaten und gekürzte Account-Hashes.
- Notes-Editor-Schema, Bridge, Save-Lifecycle und WebView wurden nicht geändert.
- Bestehende Account-, Backend-, Theme-, Sync-, Widget- und Pencil-Kompatibilität wurde nicht absichtlich umgebaut.

## Validierung

Bestätigt:

- Fokussierte integrierte Tests: **35/35 Tests, 2/2 Suites**
  - `task-alarms.test.ts`
  - `task-notifications.test.ts`
- Vorheriger vollständiger mobiler Lauf auf dem Kandidaten: **357/357 Tests, 35 Suites**
- iPhone ARM64 Simulator-Build: **BUILD SUCCEEDED**
- iPad ARM64 Simulator-Build: **BUILD SUCCEEDED**
- Alle Implementierungs- und Dokumentationscommits sind SSH-signiert.
- `test` enthält die signierten Commits:
  - `ff01c6053` AlarmKit-/Navigation-Grundintegration
  - `ebeec694d` per-Occurrence-Reconciliation
  - `580d34d82` Privacy-/Delivery-Korrekturen
  - `cb19ac754` Privacy- und Cancellation-Failure-Handling
  - `9f1243c87` abschließende Bookkeeping-Korrekturen
  - `bd2c9a76a`, `f82bee0b3` QA-/Statusdokumentation

Nicht vollständig bestätigt:

- Der letzte native Swift-Korrekturstand wurde nach den vorherigen erfolgreichen ARM64-Builds nicht noch einmal mit einem isolierten frischen DerivedData-Verzeichnis gebaut.
- Ein paralleler signierter Build lief einmal in denselben DerivedData und scheiterte ausschließlich an einer gesperrten `build.db`, nicht an einem Swift-/Linkerfehler.
- Vollständiges mobiles TypeScript hat weiterhin genau eine Meldung im unveränderten Editor-Abhängigkeitsbereich:
  `app/screens/editor/tiptap/use-editor.ts:133`, implizites `state`-`any`.
- Interaktive Simulator-Workflows wurden nicht zuverlässig abgeschlossen; die installierte App scheiterte in einem Lauf am Simulator-Launchd-Fehler 163.
- Die tatsächliche GUI für Xcode 27 ist Device Hub unter `Contents/Applications`; eine alte `Simulator.app`-Annahme ist falsch.

## Nicht umgesetzt oder bewusst nicht versprochen

- Keine physische iPhone-Prüfung. Status: `PHYSICAL_QA_PENDING`.
- Sound, Haptik, Silent-Mode-Verhalten und gesperrter-Gerät-Alarm sind nicht verifiziert.
- Kein Versprechen, dass ein Alarm oder eine Notification im Hintergrund App-Code startet.
- Eine Live Activity kann nur bei App-Launch, Foreground, abgeschlossenem Sync oder relevanter Settings-/App-Lock-Reconciliation gestartet/aktualisiert werden.
- Eine im Hintergrund fällig gewordene Task bekommt keine garantierte neue Live Activity, solange die App nicht wieder läuft.
- Live Activity ist nicht Notification Center; Lock Screen und Notification Center sind getrennte Flächen.
- Keine undokumentierten APIs, privaten Frameworks, Critical-Alert-Entitlements oder Silent-Switch-Tricks.
- Keine Push-Infrastruktur oder Serveränderung.
- Keine Garantie einer unbegrenzt persistenten oder undismissbaren Systemfläche.
- Keine Garantie, dass ein bereits laufender Alarm nachträglich in place redigiert wird; AlarmKit erlaubt hierfür keine öffentliche Attribute-Änderung. Die Implementierung lässt aktive/gesnoozte/pausierte Präsentationen bestehen und meldet die Datenschutzgrenze ehrlich.
- Kein TestFlight-, App-Store-, Produktionsserver- oder Remote-Push-Schritt.
- Luna Reserve konnte den letzten Pass wegen des Account-Kontingents nicht starten; der gemeldete Reset war 2026-10-03 22:46 Europe/Oslo. Die letzten kleinen Korrekturen wurden anschließend unter expliziter Benutzerfreigabe lokal fertiggestellt.

## Relevante Dateien

- `apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmModule.swift`
- `apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmSurface.swift`
- `apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmModule.m`
- `apps/mobile/ios/NotesWidget/NotesWidget.swift`
- `apps/mobile/app/services/task-alarms.ts`
- `apps/mobile/app/services/task-alarm-plan.ts`
- `apps/mobile/app/services/task-notifications.ts`
- `apps/mobile/app/services/task-navigation.ts`
- `apps/mobile/app/screens/tasks/index.tsx`
- `apps/mobile/app/screens/tasks/task-focus.ts`
- `apps/mobile/app/services/notifications.ts`
- `apps/mobile/app/hooks/use-app-events.tsx`
- `apps/mobile/app/services/reminder-widget.ts`
- `docs/urgent-reminders-architecture.md`
- `artifacts/urgent-reminders-qa.md`

## Empfohlene nächste Schritte für Claude

1. Kandidatenstand `f82bee0b31eb5a8100022a16e96049af65d1b319` in einem sauberen Checkout prüfen.
2. Native Build mit einem neuen, exklusiven DerivedData-Verzeichnis wiederholen; keine parallelen Xcode-Builds teilen ein DerivedData-Verzeichnis.
3. Danach fokussierte Simulator-Workflows durchführen: New Note Save/Reopen, Task-Notification warm/cold, moved/deleted/completed Task, App Lock, Highlight/kein Editor, Widget Completion.
4. Wenn ein physisches iPhone verfügbar ist, Alarm, Stop, Snooze, Sound/Haptik, Lock Screen, Dynamic Island und Completion-Cleanup testen.
5. Keine Änderungen an Notes-Editor, Account-/Backend-Fix, Theme, Bundle-IDs, App Groups oder Keychain-Gruppen ohne separaten Auftrag.
6. Erst nach dieser QA einen Release- oder Upload-Schritt separat autorisieren lassen.

## Arbeitsbaum-Hinweis

Die folgenden untracked Dateien im Hauptcheckout sind absichtlich erhalten und dürfen nicht versehentlich gestaged werden:

- `AGENTS.md`
- `artifacts/.urgent-deepseek-input-05f16225/`
- `artifacts/.urgent-deepseek-input-3d6a6f1d/`
- `artifacts/.urgent-deepseek-input-4a52337d/`

