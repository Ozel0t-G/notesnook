# Master V2 – Dateizuständigkeiten und Integrationsvertrag (15.10.2026)

Deadline: Samstag, 17.10.2026 abends (Europe/Oslo). Donnerstag: Titelintegrität und Plattformpakete; Freitag: wesentliche visuelle Integration; Samstag: RC-Stabilisierung und Gesamtprüfung. Offene Anforderungen bleiben offen, kein Upload/Release/Commit/Push.

## Verbindliche Eigentümer

| Eigentümer | Dateien / Bereich | Status |
|---|---|---|
| ROOT / Integrator | `packages/editor/**`, `packages/editor-mobile/**`, `packages/core/**`, `packages/common/**`, `packages/theme/**`, `packages/ui/**`, `packages/intl/**`; alle anderen gemeinsamen Pakete; `apps/mobile/app/screens/editor/**`, Speicher-/Sync-/Vault-Dienste; `apps/mobile/ios/Notesnook/AppDelegate.*`; Build-/Projektkonfiguration; Schnittstellen, Rootregeln, Matrix/Checkpoints | einziger Schreiber; kritische Titelintegrität zuerst |
| A – MACOS | `apps/mobile/ios/Notesnook/MacMenu/**`; `apps/mobile/app/components/mac-*.tsx` samt Tests; `apps/mobile/app/hooks/use-mac-*.ts` samt Tests; `apps/mobile/app/stores/use-mac-*.ts`; `apps/mobile/app/utils/mac-*.ts`; `apps/mobile/app/screens/settings/mac-*.ts`; `apps/mobile/app/services/mac-list-navigation.ts` und `mac-modal-stack.*` | isoliertes Codex-Schreibpaket A; nur eigener Workspace |
| B – IPHONE | `apps/mobile/app/screens/library/**`; `apps/mobile/app/components/apple-tab-bar*`; `apps/mobile/ios/Notesnook/VeyraNTabBar/**`; `apps/mobile/app/components/list-items/note/**`, `list-items/selection-wrapper/**`; konkrete Listen-/Search-/Tasks-Dateien zunächst Vorschläge an Root, kein pauschales Verzeichnisrecht | isoliertes Codex-Schreibpaket B; shared Auswirkungen explizit prüfen |
| C – IPAD | `apps/mobile/app/navigation/fluid-panels-view.*`, `apps/mobile/app/components/fluid-panels/**`; `apps/mobile/app/components/list-items/headers/notebook-header.tsx` samt benachbartem Test; neue `apps/mobile/app/components/ipad-notebook-*.tsx` samt Tests | eigener Codex-Workspace C aktiv; 462176 Einträge / 7387 Quellhashes vollständig geprüft |
| ROOT – alle nicht explizit zugeordneten Dateien | einschließlich Shared-Header, Navigation, Tasks, Settings, Themeengine und QA-Skripte | ausschließlich Root; Vorschläge anderer Agenten statt Schreibzugriff |

Mehrere Plattformen dürfen dieselbe Datei lesen. Schreibrechte gelten nur für ausdrücklich zugeordnete Dateien; keine Änderung gemeinsam genutzter Schnittstellen ohne Root. Kein Agent verändert die Originalkopie. Quelle ist der vollständige aktuelle dirty-test-Stand, niemals HEAD/Source36. Jede Übernahme prüft Baseline-Hash und übernimmt nur geprüften inhaltlichen Diff nacheinander; Konflikt = manuelle Integration, kein Überschreiben aus alter Kopie.

## Technischer Modus / Isolation

Die zwei unterstützten lokalen Codex-Aufgaben verwenden jeweils einen eigenen vollständigen Repository-Klon des aktuellen dirty-test-Stands. Kein neues Setup und kein Git-Reset. APFS-Copy-on-write spart Platz; reguläre Dateien haben getrennte Inodes. Vor Freigabe wurden 462172 Einträge und 7386 Quell-Dateihashes pro Kopie verglichen; kein Symlink zeigt in die Originalkopie.

- A: `/Users/ozel0t/Documents/Codex/2026-10-15/veyran-master-v2-a-mac/repo`, Task `01a13dd4-3bd1-72e1-8b40-76aa092b09ab`.
- B: `/Users/ozel0t/Documents/Codex/2026-10-15/veyran-master-v2-b-iphone/repo`, Task `01a13dd4-6696-74c1-81f6-25ebca01563a`.
- ROOT: `/Users/ozel0t/Notesnook/notesnook`. Gemeinsamer Editor-/Speicherpfad bleibt ausschließlich hier schreibbar. Der kritische Titelpfad ist dadurch klar von A/B isoliert.

Der managed-worktree-Aufruf war wegen des übergeordneten gespeicherten Projektpfads nicht möglich; die registrierten projectless Codex-Arbeitsbereiche sind die unterstützte Alternative. Keine Änderung an globaler Konfiguration, keine Umgehung von AI-workers-Sperren. Direkte Codex-Implementierung gemäß temporärer Ausnahme; Pflichtreviews unverändert. A wurde nach exakten before/after-Hashes und unabhängigen Pflichtreviews übernommen; 12 betroffene Reacttests bestehen im Original. Erste Integration damit nachgewiesen. C darf nach seiner vollständigen Kopieprüfung starten.

Jedes Paket liefert tatsächlichen Diff gegenüber dem verifizierten dirty-Baseline-Stand (nicht HEAD), Dateihashes, implementierte Funktionen, gezielte Tests und offene Shared-Vorschläge. Berichte, Logs und Buildprodukte außerhalb des jeweiligen `repo`. Keine eigenständige Simulatorsteuerung, Installation oder vollständigen Builds: ROOT koordiniert Build-Ausgaben und isolierte QA-Apps. Fehlende Runtimebelege ausdrücklich UNVERIFIED. ROOT prüft vor jeder sequenziellen Übernahme Baseline und Diff; keine pauschalen Dateiüberschreibungen. Titel-/Save-Dateien bleiben exklusiv bei ROOT.

Gültige Teilabnahmen übernehmen, keine neuen Gesamtaudits. Vorhandene Funktionen, Daten, Formate und Custom-Konfiguration erhalten. Connect zurückgestellt, Assistant ausschließlich Geometrie. AGENTS/Designsystem/DeepSeek-Pflichtreviews unverändert. Codex implementiert gemäß bestehender temporärer Ausnahme.

## Integration 15.10.2026

A erste Einheit (mac-sidebar.tsx + neuer Reacttest) einzeln auf dirty-test integriert und mit12Tests geprüft; native/visuelle Abnahme bleibt offen. C Arbeitsbereich `/Users/ozel0t/Documents/Codex/2026-10-15/veyran-master-v2-c-ipad/repo`, Task `01a13ded-297b-75c2-991d-cc29f8fd3396`. C beginnt nur mit iPad-Notebookkopf/Informationszugang gemäß10.3; vorhandene adaptiveCollection-Verkabelung übernehmen. NotebookScreen-Daten/Navigation, Properties und Editor-Speichern bleiben ROOT. Alle Bereiche halten NativeBuild/QA-Steuerung zentral.

C2 ownership extension 2026-10-15: C exclusively owns side-menu/*.tsx and adjacent tests in its isolated copy for hardware-iPad-only source/sidebar presentation; stores.ts and dragging-store.ts remain Root. All shared navigation/theme/editor/save APIs read-only. A3 active in A-owned sidebar/footer/hook. Root alone builds/integrates/operates QA. B frozen after integrated handoff.

B3 ownership extension 2026-10-15: B exclusively owns `apps/mobile/app/components/list/list-item.wrapper.tsx` and `apps/mobile/app/components/list-items/headers/section-header.tsx` plus adjacent dedicated tests for Phone-only grouped note presentation. Original and B-copy exact bytes verified in external b3-ownership-baseline.json. Existing B note/selection-wrapper ownership retained. Core VirtualizedGrouping/theme/storage/shared APIs stay read-only; Root/A/C do not edit these two files during B3. No navigation/core refactor.

C4 limited extension: only new components/ipad-primary-destinations.tsx and adjacent .test.tsx belong to C for a pure callback-driven Notes/Tasks/Search presentation (baseline absence verified). Root keeps navigation-stack, AppleTabBar/layout/context and actual consumer integration. No second navigation store or route ownership. Existing C3 frozen.

## File coordination transport — 15.10.2026 user authorization

Existing isolated A/B/C sessions and ownership remain unchanged. READY/status files are authoritative; Root alone writes `qa/core-master-v2-20261012/parallel-deadline/TASK-QUEUE.json` (outside repo), atomically. Agents acknowledge assignment IDs in their own `outputs/coordination/<id>/ACK.json`, publish READY atomically, and check the shared queue once at handoff. Root polls during the existing heartbeat, verifies/reviews/integrates exact deltas, records ACCEPTED/REJECTED and supplies the next bounded assignment. No busy-loop daemon.

Root may wake the exact existing session with the installed supported `codex queue --thread <UUID> --message <file-task-reference>`; identity/cwd/status are checked first. At most one dispatch per assignment: save message ID, inspect ACK/thread before any retry. Queue must not introduce another exec/resume worker or session; active turns finish before queued followups. No CLI permission, sandbox, config or trust overrides. `send_message_to_thread` is only a batched fallback when file coordination and supported continuation are insufficient. Actual security approvals remain intact.

Verified against real C4 handoff: exact2 files accepted after independent DIFF20 and Root7 React/full mobile types; CLI queue exit0 resumed the same C session and produced its assignment ACK, with no manual MCP confirmation. Receipt: external `parallel-deadline/file-coordination-e2e.json`. This verifies coordination, not native C4 design/consumer acceptance.

B7 temporary narrow ownership: B alone edits components/list/card.tsx and new card.test.tsx for Phone-only density/wrapping/accessibility; message/auth/business logic, shared headers/nav remain read-only. Baseline external b7-ownership-baseline.json. C5 owns only new navigation/ipad-primary-workspace.integration.test.tsx; five frozen Rootconsumer inputs c5-inputs are read-only/excluded from patch. Root retains all consumer source ownership.

A7 bounded ownership: A alone owns NEW components/mac-note-row-content.tsx and adjacent .test.tsx (absencebaseline a7-ownership-baseline.json). Pure title/date/preview presentation; Root alone later integrates existing NoteItem, no A edits to B/Root/shared sources. Three original sessions remain; all notices/ACK/READY via TASK-QUEUE and exact-session CLIqueue.
