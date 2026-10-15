# VeyraN Connect — lokaler Run-Stand (11.10.2026)

## Nutzbar auf diesem Entwicklungs-Mac

- Das lokale Codex-Plugin `veyran-connect@veyran-local` ist über das geprüfte
  Codex-Plugin-Marketplace-Format installiert und aktiviert. Es stellt zwölf
  Notiz-/Taskwerkzeuge über stdio MCP bereit; zusätzlich gibt es die klar
  getrennte optionale Inbox-Aktion `capture_note`.
- Der loopback-only TLS-Broker läuft in der aktuellen Entwicklungs-Sitzung auf
  `127.0.0.1:47821`. Zum Beenden `Ctrl-C` in der Broker-Sitzung.
- VeyraN muss die private Pairing-Datei in **Einstellungen → VeyraN Connect**
  importieren und dort die gewünschten Capabilities freigeben. Die bereits
  exportierte Datei liegt mit Modus `0600` unter
  `~/.veyran-connect/connection.export.json`; ihr Inhalt wurde nicht gelesen.
- Die letzte Statusabfrage des lokalen App-Brokers ergab `APP_UNAVAILABLE`.
  Daher sind persönliche Notiz-/Taskwerkzeuge noch nicht live gekoppelt; es
  wurden keine persönlichen Notizen gelesen oder verändert. Der Import ist der
  minimale noch nötige lokale Schritt.
- Nach einem App-Neustart oder wenn Codex die neuen Werkzeuge noch nicht
  geladen hat: Codex neu starten. Setup-Befehle und optionale Inbox-Key-Einrichtung
  stehen in `servers/veyran-connect/INSTALL.md` und
  `plugin/veyran-connect/README.md`.

## Implementierte Teile

- Versionierte Core Connect Aktionsschicht für Status/Capabilities, Notizen,
  Notizbücher, lokale Suche sowie echte Task-Records, mit Limits,
  Konto-/Grant-Prüfung, Idempotenz und Revisionskonflikten.
- Native Paarung und eingeschränkter App-Broker für Mac Catalyst/iOS; stdio MCP,
  loopback TLS, Codex-Plugin und VeyraN-Arbeitsskill.
- Mac Catalyst SIWC mit PKCE/systemgestütztem Login, validierter registrierter
  Client- und Benutzeridentität, nativer Keychain-Ablage und Responses-Streaming.
  iOS/iPadOS werden vor Zugriff auf Login oder Notizkontext ausdrücklich als
  nicht unterstützt gemeldet.
- Nativer Assistent mit Zusammenfassen, Umformulieren, Frage zur geprüften
  aktuellen Notiz, Draft sowie expliziten Aktionen: als neue Notiz speichern,
  an die geprüfte Notiz anhängen oder als echten Task anlegen.
- Optionales `capture_note` nutzt ausschließlich die feste offizielle Inbox-API,
  eine separat lokal gespeicherte Inbox-API-Kennung, begrenzte lokale Receipts
  und einen pro Profil über Prozesse hinweg exklusiven Schreib-Lock.

## Überprüfung

- Core Connect: 234 Tests bestanden; CJS/ESM/Typdeklarations-Build bestanden.
- VeyraN-Connect-Server/MCP vor den letzten Inbox-Härtungen: 14 Suites / 157
  Tests; nach Key-Bindung, Cross-Process-Lock und Fehlerkorrekturen: 14 Suites /
  158 Tests bestanden, außerdem Typecheck bestanden. Der abschließende
  Produktions-Build wird nach den finalen Änderungen erneut ausgeführt.
- Assistant/SIWC: 5 Jest-Suites / 88 Tests und Mobile TypeScript-Prüfung bestanden.
- Xcode iOS-Simulator-Build und Mac Catalyst-Build bestanden. Catalyst wurde
  unsigniert gebaut; kein privates Nutzerprofil installiert oder angemeldet.
  Simulatorprüfung nutzte ein isoliertes synthetisches Profil und erreichte den
  VeyraN-Willkommensbildschirm. Kein persönlicher Live-Login oder Inferenztest.
- Tests für `capture_note` verwenden ausschließlich injizierte Sender; es wurde
  kein echter Inbox-Aufruf gemacht. Es wurde kein echter Modellaufruf ausgelöst.
- Web bleibt im gemeinsamen Core-Paket; ein unabhängiger Web-Produktionsbuild
  wurde nicht durchgeführt. ESLint war im App-Paket nicht installiert.

## Externe Voraussetzungen und Grenzen

- Die Geräteanmeldung und Kontoberechtigung für SIWC sind ungeprüft, bis der
  Nutzer den ersten Login selbst auf dem Mac ausführt. Beim Login muss ein von
  OpenAI tatsächlich unterstütztes ChatGPT-Modell/Kontozugriff verfügbar sein.
  Die Oberfläche warnt: „Nutzung kann ChatGPT-Kontingent oder vorhandene Credits
  verbrauchen. Reine Abo-Nutzung ist nicht garantiert.“ Kein OpenAI-API-Key,
  Anbieter-Fallback, Credit-Kauf oder Auto-Aufladung wird verwendet.
- Der erste echte Inferenztest ist ausschließlich eine manuelle Nutzeraktion.
- Gehostetes ChatGPT kann den lokalen stdio-Server nicht erreichen. Es wurde
  kein Remote-OAuth-MCP-Endpunkt und kein öffentlicher Dienst eingerichtet;
  dazu fehlt eine ausdrücklich autorisierte Bereitstellung.
- Ersetzen einer Editor-Selektion und Responses Function-Calling-Schleifen sind
  nicht implementiert: der React-Native-Editor liefert derzeit keine sichere
  Auswahl-Action-Schnittstelle bzw. der Provider keine Fortsetzungs-API. Die
  drei vorhandenen Aktionen sind direkt in der UI auswählbar und laufen über
  den gemeinsamen Aktionsadapter. Chatverläufe bleiben im Arbeitsspeicher.
- Die Notesnook Inbox-API bestätigt Annahme/Verschlüsselung/Warteschlange, aber
  liefert keine endgültige Notiz-ID und keine Statusabfrage. Der Client muss
  anschließend synchronisieren und über seinen bestehenden verschlüsselten
  Importpfad übernehmen. Der TLS-terminierende Inbox-Dienst sieht den Text vor
  der Verschlüsselung.

## Implementierer und Änderungen

DeepSeek lieferte überwiegend die MCP-/Plugin-/Inbox- und UI-Arbeit über
abgegrenzte Bridge-Aufträge. Der Audit zeigt echte getrennte Analysten-, Review-
und Test-Worker. Einige große Korrekturläufe endeten mit `error_max_turns` bzw.
`unrecognized_model`; nach diesen begrenzten Versuchen wurden die nicht
integrierten, isolierten Inbox-Änderungen geprüft und eng begrenzt durch Codex
übernommen. Codex verantwortete außerdem die Core-Integration, die
Integrationskorrekturen, Tests und Gesamtreview. Keine Kundeninhalte oder
Geheimnisse wurden an Worker übergeben.

Die Änderungen liegen in den Connect-Modulen unter `packages/core/src/connect/`,
der mobilen App unter `apps/mobile/app/services/veyran-{connect,assistant,siwc}/`
und `apps/mobile/ios/Notesnook/VeyraNConnect/`, sowie unter
`servers/veyran-connect/`, `plugin/` und `docs/veyran-connect/`.

Der Branch ist `test`. Es gab keine Commits, Pushes, PRs, Merges, öffentlichen
Deployments, TestFlight-/App-Store-Uploads oder Änderungen an produktiven
Diensten.
