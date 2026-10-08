# VeyraN Urgent Reminders — Implementierungsbericht

Stand: 8. Oktober 2026. Branch `test`, unveränderter HEAD `5b39107621b2edaa84f6a543b317bae450829671`. Änderungen liegen ausschließlich uncommitted vor. Kein Commit, Push, PR, Merge, TestFlight-Upload oder Release wurde durchgeführt. Vorhandene lokale Änderungen wurden erhalten.

## 1. Ergebnis

Implementiert wurden systemblaues AlarmKit-Styling, neun Minuten Snooze, ein angebundener nativer Stop-Intent, ein persistierter Zustand „gestoppt, unerledigt“, eine ruhige Reminder-Live-Activity ohne roten Overdue-Timer, direkte Completion über die vorhandene verschlüsselte Task-Domain und ein eigener Reschedule-Pfad zum tatsächlichen Task-Editor. Die kompakte Dynamic Island zeigt statische blaue Symbole.

Die Umsetzung ist ein überprüfbarer lokaler Kandidat, keine uneingeschränkte Apple-Paritäts- oder Releasefreigabe. Im iOS-27-Simulator funktioniert der unmittelbare Kartenwechsel beim Stop-Button der Snooze-Live-Activity. Beim systemeigenen Full-Screen-Slider wird unser Stop-Intent zwar ausgeführt, ActivityKit verweigert aber die neue Activity wegen fehlender Ausführungsberechtigung für den Request. Der dauerhafte Stop-Zustand bleibt korrekt gespeichert; der nächste zulässige App-Abgleich erzeugt die Karte. Diese Einschränkung wurde auch nach erteilter Live-Activity-Freigabe reproduziert.

## 2. Ursache der bisherigen Darstellung

AlarmKit war im aktuellen Ausgangsstand bereits angeschlossen; die historischen Dokumente über ausschließlich normale Notifications waren nicht mehr die aktuelle Fehlerursache. Es fehlte die Verknüpfung des vorhandenen Stop-Intents mit `AlarmConfiguration.stopIntent`. Nach Stop zeigte der appseitige Abgleich eine separate rote Overdue-Live-Activity mit hochzählender Zeit. Das erzeugte den Eindruck eines weiterlaufenden Timers. Der Alarm verwendete außerdem die Listenfarbe und zehn Minuten Snooze.

AlarmKit selbst ist die vorgesehene öffentliche API. Apple kontrolliert große Uhrzeit, Slider, Alarmpräsentation, Ton und Haptik. Ein öffentlicher Schalter für Apples interne Erinnerungen-Darstellung wurde nicht gefunden. Die konkrete Testliste war schon vorher blau; eine pauschal grüne oder rote Ausgangs-Alarmdarstellung wird daher nicht behauptet.

## 3. Zustandsmaschine

| Zustand | Verhalten |
|---|---|
| SCHEDULED | AlarmKit pro Account/Occurrence, bestätigte Planung unterdrückt die zusätzliche hörbare Standardnotification. |
| ALERTING | Native AlarmKit-Oberfläche, Systemblau, erlaubter Task-Titel oder neutraler Privacy-Text. Keine konkurrierende Overdue-Karte. |
| SNOOZED | Derselbe Alarm zählt neun Minuten herunter. Keine Änderung der ursprünglichen Task-Fälligkeit oder RRULE. |
| STOPPED_BUT_INCOMPLETE | Ton/Alarm enden, Task bleibt offen; minimaler Stop-Marker wird dauerhaft gespeichert. Separate stille Karte direkt, wenn iOS den Request zulässt, sonst beim nächsten zulässigen Abgleich. |
| COMPLETED | Snapshot-/Scope-/Revision-/Due-Prüfung, dauerhafte bestehende Queue und echter Core-Abschluss. Erst bestätigte Speicherung ist Erfolg; danach werden Surfaces bereinigt. |
| RESCHEDULED | Bestehender Task-Editor mit aufgeklapptem Datumspicker. Nach Speichern alte Surfaces entfernen und neue Fälligkeit planen. Alte Stop-Marker dürfen nicht in die neue Occurrence wandern. |
| REMOVED_OR_DISABLED | Completion, Löschen, Urgent aus, Reminder entfernen und Accountwechsel bereinigen die zugehörigen Surfaces. |

## 4. Dateien und Integration

Die Änderungen betreffen die folgenden Verantwortungen:

- `TaskAlarmModule.swift/.m`: native Planung, Stop-Konfiguration, Scope-Vertrag, Serialisierung, Datenschutzwechsel und Activity-Abgleich.
- `TaskAlarmSurface.swift`: minimale geschützte Identitäts-/Lifecycle-Stores, Stop-/Completion-Intents, rückwärtskompatible Activity-Felder.
- `NotesWidget.swift`: ruhige Lock-Screen-/Island-Karte und direkte Aktionen.
- `TaskWidgetCompletionIntent.swift` / `ReminderWidgetModule.swift`: gemeinsame Snapshot-Validierung und atomar geschützte Projektion.
- `task-alarm-plan.ts`, `task-alarms.ts`, `task-notifications.ts`: Occurrence-Zustände, Exklusivität, Privacy und Accountgeneration.
- `reminder-widget.ts`: bestätigte Completion und anschließender Surface-Abgleich über die vorhandene Pipeline.
- `reminder-widget-links.ts`, `task-navigation.ts`, `use-app-events.tsx`, Navigation-Store und Task-Detail: geprüfte Links, Listen-Tap und eigener Neuplanungs-Kontext.
- Regressionssuiten, Swift-Lifecycle-Harness, Lokalisierungskatalog und Dokumentation.

Core-Datenmodell, E2EE, Sync-Protokoll, Backend, Bundle-IDs, App Groups und Entitlements wurden nicht verändert. Android-, Web-, macOS-Task- und Notes-Editor-Implementierungen wurden nicht umgebaut. Die bereits vorhandene Gruppenumordnung in der Xcode-Projektdatei bleibt erhalten; die neue Projektänderung bindet nur den bestehenden Lokalisierungskatalog auch in das App-Target ein.

## 5. Visueller Vergleich

Echte Aufnahmen liegen unter `/Users/ozel0t/Notesnook/qa/urgent-parity-20261008/`; die wesentlichen Test- und Laufzeitlogs sind dort zusätzlich im Unterordner `logs` gesichert. Es wurden nur künstliche Aufgaben aufgenommen.

| Merkmal | Ausgangsstand | Implementierung / belegter Stand |
|---|---|---|
| Alarm | Native AlarmKit-Uhr und Slider; listenabhängige Farbe | Feste Systemblau-Konfiguration; native Uhr/Slider bleiben systemkontrolliert |
| Snooze | Zehn Minuten, Aufnahme 9:59 | Neun Minuten, Aufnahme 9:00 und laufender Countdown |
| Nach Stop | Nach App-Abgleich roter hochzählender Overdue-Timer | Ruhige Karte mit statischer Fälligkeit, Checkbox und Neuplanung |
| Compact Island | Roter laufender Overdue-Zähler | Kleine blaue Symbole ohne Zähler |
| Completion | Nicht auf der Overdue-Karte | Echte Hintergrund-Completion samt Entfernen der Karte im Simulator belegt |
| Neuplanung | Allgemeines Öffnen/Highlight | Richtiger Editor mit expandiertem Datumspicker belegt |
| Light/Dark | Keine neue Aussage | Karte in beiden Simulator-Einstellungen lesbar; iOS verwendet hier jeweils eine dunkle Lock-Screen-Karte |

**VISUAL_REFERENCE_QA_PENDING:** Apples Erinnerungen-App auf dem frischen Simulator bot ohne iCloud-Account keine Urgent-Funktion an. Es gibt daher keinen belastbaren direkten Apple-Screenshotvergleich von Abständen, Schriftgrößen, Slider-/Snooze-Details oder Expanded Island. Die neun Minuten sind die implementierte Zielentscheidung, keine in dieser Sitzung bestätigte Apple-Referenzmessung. Expanded Island, VoiceOver, große Dynamic-Type-Stufen, lange Titel und deutsche/Bokmål-Laufzeitdarstellungen benötigen weitere visuelle QA.

## 6. Öffentliche API-Grenzen und Fallback

- `LiveActivityIntent` darf grundsätzlich eine Activity im Hintergrund starten. Das bedeutet nicht, dass jeder AlarmKit-Systempfad auf jeder OS-Version die erforderliche Request-Berechtigung bereitstellt. Der Unterschied zwischen System-Slider und Live-Activity-Button wurde konkret protokolliert.
- Die sofortige Stop-Karte verwendet konservativ „VeyraN Task“. Erst ein App-Abgleich mit verifiziertem Privacy-Zustand kann den freigegebenen Titel einsetzen.
- Normale Live Activities sind nicht dauerhaft: bis zu acht aktive Stunden, anschließend gegebenenfalls bis zu vier weitere Stunden auf dem Sperrbildschirm. Die App verwendet zusätzlich ein konservatives Acht-Stunden-Fenster ab Fälligkeit und höchstens fünf Kandidaten. iOS kann weniger zulassen, die Activity entfernen oder eine andere Island bevorzugen.
- Keine Wiederbelebung in Endlosschleifen, kein JS-Timer, keine privaten APIs und keine Critical-Alert-Tricks. Nach Ablauf bleibt der Task in der App überfällig. Es wurde keine zusätzliche periodische stille Notification als Ersatz für unbegrenzte Sichtbarkeit eingeführt.
- App Lock während Snooze erfordert eine native Ersatzplanung mit neutralem Titel. Die Restzeit wird möglichst aus dem öffentlichen Activity-Zustand übernommen. Ist sie nicht lesbar, kann ein begrenzter voller Snooze-Zeitraum die erneute Alarmierung verzögern. Dieser Randfall ist keine behauptete exakte Apple-Parität.
- Vor dem ersten Entsperren nach Neustart können geschützte Store-/Datenbankzugriffe fehlen. Dann wird keine Completion vorgetäuscht und kein Schutz umgangen.

Quellen: [AlarmKit-Konfiguration](https://developer.apple.com/documentation/alarmkit/scheduling-an-alarm-with-alarmkit), [LiveActivityIntent](https://developer.apple.com/documentation/appintents/liveactivityintent), [ActivityKit-Lebensdauer](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities), [WWDC25](https://developer.apple.com/videos/play/wwdc2025/230/). Signaturen wurden am installierten Xcode-27-Release-SDK geprüft; iOS 26.2 wurde nicht ausgeführt.

## 7. Tests

Exakte reproduzierbare Befehle, Umgebungsdaten und Testmatrix: [QA-Bericht](urgent-reminders-qa.md). Codex hat im finalen Stand 130 fokussierte Tests, 501 Tests im vollständigen mobilen Lauf, den TypeScript-Check und 28 native Lifecycle-Prüfungen erfolgreich ausgeführt. Der vollständige Jest-Befehl endet wegen zwei unverändert vorbestehender Suite-Ladefehler dennoch mit Exit 1. Die unveränderte Core-Domain bestand 849 Tests in 54 Dateien, ein Test bleibt TODO. Simulator-, iPhone/iPad-Geräte-SDK- und Mac-Catalyst-Builds einschließlich Widget Extension sind erfolgreich. Die danach ergänzte reine Katalogübersetzung wurde mit Apples Ressourcencompiler erfolgreich für EN/DE/NB kompiliert; dafür wurden die vollständigen nativen Builds nicht wiederholt.

## 8. DeepSeek und Codex

Projektmodus FORCE. Die übernommenen Implementierungsjobs sind `ffa8fc52-1210-49ec-8436-118c7f0a39a8`, `4c11ade8-d3ac-4498-a991-ff8df5af430e` und `2c86cf68-be32-42ee-80e0-a6b46036cc88`. Für die ersten beiden sind alle vier getrennten Worker-Rollen erfolgreich auditiert. In der letzten Runde liefen ebenfalls vier Rollen; der Testanalyst erreichte sein Turn-Limit, Repository-Analyse, Implementierung und unabhängiger Review waren erfolgreich. Der abschließende reine Übersetzungsjob `fcde4f27-8082-44fe-bf07-3ff1bd4bb7ef` wurde ebenfalls angewendet; seine vier getrennten Worker-Rollen waren erfolgreich. Codex führte die entscheidenden Tests selbst aus. Sämtlicher Produktionscode und neu geschriebene Tests stammen von tatsächlichen DeepSeek-Bridge-Aufrufen. Die Bridge setzte getrennte Repository-/Interface-Analysten, Test-/Regressionsanalysten, Implementierungs-Leads und unabhängige Integrationsreviewer ein. Codex koordinierte, prüfte Patches und SDK-Signaturen, führte Tests/Builds und Simulator-Interaktionen aus und schrieb diesen Bericht. Codex schrieb keinen Produktionscode und keine Tests.

Es gab mehrere Korrekturrunden: anfänglich fehlende Stop-Verknüpfung/Styling, Native-/JS-Vertragsfehler, Lifecycle-Serialisierung, Datenschutz/Snooze, Wiederholungsidentität und den durch die Simulator-Neuplanung entdeckten Markerfehler. Mehrere Worker-Runden erreichten ihre Turn-Grenze; ein Wiederaufnahmeversuch scheiterte an Scope-Verletzungen bei Dependency-Artefakten, eine weitere Runde am Zugriff auf externe Job-Artefakte. Diese fehlgeschlagenen Ergebnisse wurden nicht unkontrolliert angewendet. Der relevante Patch wurde danach als begrenzter In-Tree-Input bereitgestellt. Es wird nicht behauptet, dass jeder Worker-Lauf erfolgreich war.

Architektur-, Migrations-, Sicherheits- und Abschlussreview wurden als getrennte Bridge-Reviews ausgeführt. Der Abschlussreview fand keine kritische oder hohe Regression; eine mittlere Lücke bei der Verifikation nativer Löschungen sowie kleine Sanitizer-/Retry-Probleme wurden anschließend korrigiert, unabhängig im Worker-Team und nochmals durch Codex geprüft. Native Löschungen werden vor Freigabe eines Fallbacks erneut enumeriert; nicht lesbare Completion-Aktionen bleiben als fehlgeschlagener, erneut versuchbarer Vorgang erhalten. Der unabhängige finale Review verwendete 20 verifizierte DeepSeek-Anfragen. Reviewer-Vermutungen wurden überprüft: Eine vorgeschlagene Änderung der Completion-Queue wegen angeblich unveränderter Revision beim Occurrence-Wechsel war nicht begründet; Core erhöht die Revision monoton und erzeugt für neue Instanzen eigene IDs. Ebenso ist kein prozessübergreifender Lock nötig, weil diese LiveActivityIntents im App-Prozess laufen.

## 9. Bekannte Risiken

Fehlerinjektion für ein AlarmKit-`cancel`, das ohne Fehler zurückkehrt, den Alarm aber behält, wurde nicht auf einem Gerät erzwungen; die neue Schutzlogik wurde durch Codeprüfung und native Builds geprüft. Ein verbleibender niedriger Review-Hinweis betrifft die Privacy-Warnmeldung für bereits aus dem gewünschten Task-Satz entfernte Alarme, deren OS-seitige Entfernung scheitert: Die spezielle Titelwarnung kann ausbleiben. Der Zustand wird nicht als erfolgreich entfernt bestätigt.

Die größte verbleibende Funktionsgrenze ist der Kartenstart nach dem System-Slider ohne späteren App-Abgleich. Dazu kommen reale Gerätebedingungen für App Lock während aktiver Alarme, kalten Intent-Start, geschützte Daten vor erstem Unlock, mehrere gleichzeitige Activities und Activity-Ablauf. Automatisierte Scope-/Revisionstests ersetzen keinen echten Zwei-Account-Sync-Test.

Der erneute Test mit Kandidat12 bestätigte auch den korrigierten Ablauf Neuplanung → neuer Alarm → Snooze → Stop → direkte generische Karte → echte Checkbox-Erledigung. Der Update-Test erhielt die vorhandenen künstlichen Tasks. iOS entfernte die alte rote Activity beim App-Installieren; eine lückenlose visuelle In-Place-Migration wurde deshalb nicht bewiesen. Aktive alte Snooze-Alarme werden bewusst nicht allein wegen der Konfigurationsversion abgebrochen und können ihre alte Dauer bis zum Ende behalten.

## 10. Releasebereitschaft

**PHYSICAL_QA_PENDING** und **VISUAL_REFERENCE_QA_PENDING**. Vor einem verlässlichen TestFlight-Test sind die physischen Szenarien der QA-Matrix, der direkte Apple-Vergleich und die Bewertung des System-Slider-Fallbacks erforderlich. Die zwei vorbestehenden Settings-Testladefehler sind separat zu beheben oder ausdrücklich als bekannte Testumgebungsprobleme zu akzeptieren. Dieser Arbeitsauftrag autorisiert keinen Upload oder Release.

## Anhang: Dateiliste dieses Auftrags

```text
NOTESNOOK_APPLE_HANDOFF.md
apps/mobile/app/hooks/use-app-events.tsx
apps/mobile/app/screens/tasks/detail.tsx
apps/mobile/app/services/reminder-widget-completion.test.ts
apps/mobile/app/services/reminder-widget-links.test.ts
apps/mobile/app/services/reminder-widget-links.ts
apps/mobile/app/services/reminder-widget-writer.test.ts
apps/mobile/app/services/reminder-widget.ts
apps/mobile/app/services/task-alarm-plan.test.ts
apps/mobile/app/services/task-alarm-plan.ts
apps/mobile/app/services/task-alarms.test.ts
apps/mobile/app/services/task-alarms.ts
apps/mobile/app/services/task-navigation.test.ts
apps/mobile/app/services/task-navigation.ts
apps/mobile/app/services/task-notification-actions.test.ts
apps/mobile/app/services/task-notification-actions.ts
apps/mobile/app/services/task-notifications.test.ts
apps/mobile/app/services/task-notifications.ts
apps/mobile/app/stores/use-navigation-store.ts
apps/mobile/ios/NotesWidget/Localizable.xcstrings
apps/mobile/ios/NotesWidget/NotesWidget.swift
apps/mobile/ios/NotesWidget/TaskWidgetCompletionIntent.swift
apps/mobile/ios/Notesnook.xcodeproj/project.pbxproj
apps/mobile/ios/Notesnook/ReminderWidget/ReminderWidgetModule.swift
apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmModule.m
apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmModule.swift
apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmSurface.swift
apps/mobile/ios/Notesnook/TaskAlarm/Tests/TaskAlarmLifecycleStoreHarness.swift
artifacts/urgent-reminders-parity-report.md
artifacts/urgent-reminders-qa.md
docs/tasks-architecture.md
docs/urgent-reminders-architecture.md
```

Nicht enthalten sind die bereits vor Beginn vorhandenen untracked AGENTS-/Bridge-/Detox-/E2E- und Log-Dateien. Der Diff der Projektdatei enthält zusätzlich die dokumentierte vorbestehende Gruppenumordnung.

## Anhang: echte Simulatoraufnahmen

| Beleg | Aufnahme |
|---|---|
| Ausgangsstand: roter Island-Timer | [Screenshot](../../qa/urgent-parity-20261008/veyran-baseline-red-overdue-island.png) |
| Neue Fälligkeit, nativer Alarm | [Screenshot](../../qa/urgent-parity-20261008/veyran-candidate12-rescheduled-alarm.png) |
| Direkte Karte nach Snooze-Stop der neuen Fälligkeit | [Screenshot](../../qa/urgent-parity-20261008/veyran-candidate12-stop-after-reschedule.png) |
| Reduzierte Dynamic Island | [Screenshot](../../qa/urgent-parity-20261008/veyran-candidate6-reminder-island.png) |
| Neun Minuten Snooze | [Screenshot](../../qa/urgent-parity-20261008/veyran-candidate6-snooze-nine-minutes.png) |
| Light Mode | [Screenshot](../../qa/urgent-parity-20261008/veyran-candidate6-slider-fallback-light.png) |
| Dark Mode | [Screenshot](../../qa/urgent-parity-20261008/veyran-candidate6-slider-fallback-dark.png) |

Kandidatnummern unterscheiden die tatsächlich aufgenommenen Zwischenstände. Kandidat13 ändert keine Layouts; Kandidat14 ergänzt ausschließlich Übersetzungen. Kandidat13 wurde separat gebaut/getestet; ein kompletter Screenshot-Durchlauf dieses letzten Binärstands wurde nicht wiederholt.
