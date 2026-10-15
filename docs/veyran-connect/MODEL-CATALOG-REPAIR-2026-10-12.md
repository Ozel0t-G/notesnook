# Modellkatalog und Kontextvorschau – 12.10.2026

Der persönliche Browserlogin wurde vom Nutzer erfolgreich abgeschlossen. Die
Mac-Oberfläche bestätigt die ChatGPT-Verbindung. Der Modellabruf meldete bislang
nur „Kein Modell-Katalog verfügbar“, weil sämtliche nativen Fehler als
`undefined` verworfen wurden. Eine tatsächliche Modellberechtigung oder Inferenz
ist damit noch nicht bestätigt.

## Änderungen

- SIWC-Service und Assistant verwenden einen typisierten Katalogvertrag:
  Erfolg (einschließlich einer echten leeren Liste) oder eine statische,
  erlaubte Fehlermeldung. Keine raw Exception, Tokens, HTTP-Bodies oder OAuth-
  URLs werden angezeigt oder geloggt; unbekannte Codes werden fest begrenzt.
- Die Oberfläche unterscheidet Laden, leere Liste und Fehler. **Modelle neu
  laden** führt nur eine Metadatenabfrage aus. Gleichzeitige Klicks werden
  zusammengefasst; verspätete Antworten dürfen keinen neueren Katalog ersetzen.
- Während Laden oder Fehler bleibt **Senden** deaktiviert. Vorübergehende
  Metadatenfehler erhalten den RAM-Entwurf und den geprüften Notizkontext.
  Kontowechsel, verlorene Hostidentität und Widerruf verwerfen alte Daten.
- Ein Notizwechsel verwirft den Notizkontext und stoppt den Stream, aber erhält
  eine laufende kontoabhängige Modellabfrage. Der neue Regressionstest belegt
  dieses Verhalten mit einem verzögerten synthetischen Katalog.
- Der native Parser und der offizielle Endpunkt bleiben unverändert. Der
  Renderer prüft zusätzlich maximal 512 Einträge, begrenzte Namen und Modell-
  Slugs. Er inventiert keine Modelle und meldet fehlerhafte Listen nicht als
  erfolgreiche leere oder teilweise Liste.
- Die Kontextvorschau verwendet die vorhandene Bibliothek `html-to-text` als
  reine Textkonvertierung. Absätze, Listen, Unicode und Links bleiben lesbar;
  aktive HTML-Elemente werden ausgelassen. Eine Anzeigegrenze von 20.000 Zeichen
  wird sichtbar gekennzeichnet. Der tatsächliche gespeicherte HTML-Kontext,
  seine Revision und die bestehenden Sende-/Schreibkontrollen bleiben erhalten.
  Es gibt keinen neuen WebView und keine HTML-Ausführung. Interne Subject- und
  Client-Kennungen erscheinen nicht mehr als primäre Kontoinformation.

## Implementierer und Prüfungen

Projektmodus FORCE. DeepSeek lieferte den überwiegenden JS-/UI-Umfang und die
neuen Service-, Controller-, Vorschau- und Renderingtests. Der erste Lauf
`d7266258-4827-4446-832f-51af99d76378` scheiterte am Turnlimit (Lead 111
Requests, echte separate Interface-/Testanalysten 27/26 Requests). Die
Korrekturrunde `d4a06cac-96db-4a56-a9a2-2bfdf85a0062` scheiterte erneut
(Lead 78 Requests, Analysten 28/27). Alle drei Rollen wurden tatsächlich mit
dem DeepSeek-Modell ausgeführt; sie werden nicht als erfolgreich bezeichnet.

Codex übernahm nach diesen beiden begrenzten Versuchen gemäß der ausdrücklichen
Fallback-Anweisung des Nutzers. Codex korrigierte Fixture-Erwartungen,
Fail-closed-Katalogvalidierung, statische Fehlermeldungen und den Katalog-
Notizwechselkonflikt und ergänzte fünf Regressionstests. Der Kandidat wurde in
einem isolierten Checkout fertig geprüft, anschließend als eigener geprüfter
Patch integriert. Vorher wurden die ursprünglichen Dateifingerprints aller
14 betroffenen Dateien gegen den tatsächlichen Workspace geprüft; fremde
Änderungen wurden nicht überschrieben. Keine staging-/Commit-Aktion.

Im tatsächlichen Repository bestanden **9 Jest-Suites mit 174 synthetischen
Tests**, `tsc --noEmit --incremental false` und `git diff --check`. Tests
verwenden keine persönlichen Notizen, keine echte Keychain und keine Inferenz.
Das unabhängige Security-Review bestand ohne kritische/hohe Befunde. Vier
kleine Härtungshinweise (Kontrollzeichen in Anzeigenamen, alter Action-Code-
Fallback, Begrenzung des Streamentwurfs, feste Usage-Link-Beschriftung) bleiben
als Folgearbeit dokumentiert. Das Diff-Review scheiterte am Turnlimit; es wird
nicht als bestanden gemeldet. Der
signierte Mac-Release-Neubau bestand, ebenso die strenge Signaturprüfung.
Das Paket wurde unter `/Users/ozel0t/Notesnook/qa/veyran-connect-local-20261012-catalog/VeyraN.app` gestartet.
Die bestehende ChatGPT-Verbindung blieb nach dem Neustart erhalten. Der
Live-Metadatenabruf meldet jetzt den erlaubten nativen Code `model_unavailable`
(statische Anzeige: Modell-Katalog konnte nicht verarbeitet werden). Der
Provider wirft diesen Code nach HTTP 200, wenn der Katalogparser ablehnt.
Die genaue abgelehnte Form ist noch nicht beobachtet; ein Berechtigungsproblem
wird deshalb nicht behauptet. Keine Inferenz wurde gestartet.

Nächster Schritt: Gegen die offiziell dokumentierten `/v1/models`-Formate
prüfen (SIWC: `models`/`slug`/`display_name`/`visibility`; API-Referenz:
`object:list`/`data`/`id`). Erst strukturelle, geheimnisfreie Diagnosen bzw.
bestätigte kompatible Anpassung, keine erfundenen Modelle oder Endpunkte.
Die native Callbackarbeit läuft getrennt in Job
`ff44f054-45d8-4cdc-906c-620ee7b14e34`; dessen native Dateien werden während
des laufenden Jobs nicht von Codex geändert.

## Betrieb

Nach Aktualisierung des lokalen Pakets: Einstellungen → VeyraN Assistant →
**Modelle neu laden**. Bei erfolgreicher Liste ein tatsächlich angebotenes
Modell auswählen. Eine erste KI-Anfrage löst ausschließlich der Nutzer aus,
idealerweise mit einer kleinen synthetischen Notiz. Die Oberfläche garantiert
keine reine Abo-Nutzung; vorhandene ChatGPT-Credits können verwendet werden.
Es gibt keinen separaten Modell-API-Key, Anbieterwechsel, Credit-Kauf oder
Auto-Aufladung. Es erfolgten keine Pushes oder öffentlichen/produktiven Änderungen.

Der Anmeldeablauf wurde von DeepSeek erfolgreich als Job
`ff44f054-45d8-4cdc-906c-620ee7b14e34` implementiert, unabhängig reviewt
und nach einer Korrekturrunde abgeschlossen. Echte Rollen: Interface-Analyse
26 Requests, Testanalyse 17, Implementierung 104, unabhängiges Review 32,
Korrektur 85. Codex prüfte und integrierte den Patch. Lokaler nativer Harness
bestand mit 634 Checks, darunter synthetische echte Loopback-Verbindungen.
Ein separater kleiner Katalogformat-Job
`9cf6c395-c165-40f0-89ce-19331332a237` läuft nun für die zwei dokumentierten
Antwortformen und den Schutz vor bereits widerrufenen Prepared-Callbacks.

Der fokussierte abschließende Review der integrierten SIWC-Reparaturen wurde
mit 18 echten DeepSeek-Requests erfolgreich abgeschlossen: **Accept**, keine
kritischen/hohen Befunde. Kleine Restpunkte sind dokumentiert: Ein Abbruch
unmittelbar nach einer bereits erfolgten Credential-Persistenz kann bis zur
nächsten Statusprüfung „Abgebrochen“ anzeigen; bereits gespeicherte Credentials
werden dadurch nicht gelöscht. Die asynchrone Main-Queue ist eine explizite
Opener-Contract-Annahme; weitere Hinweise betreffen bestehende Stream-/Logout-
Kommentare und Flags. Kein neuer persönlicher Login oder Inferenztest durch
Codex.

Der 694-Check-Katalogformat-Patch und der signierte Releasebuild wurden lokal
validiert. Das gestartete Paket
`/Users/ozel0t/Notesnook/qa/veyran-connect-local-20261012-models/VeyraN.app`
meldet jedoch weiterhin `model_unavailable`. Die Anmeldung blieb erneut
erhalten. Deshalb ist die echte Modellliste noch nicht als funktionierend
bestätigt. Ein kleiner Folgejob
`55fc001c-98d8-41a0-9650-fc23ab044683` untersucht die bislang auf 32
begrenzten zusätzlichen Metadatenfelder und ergänzt ausschließlich sichere
Strukturzähler bei Parserfehlern (keine Schlüssel-/Feldwerte, IDs, Tokens oder
Notizinhalte). Noch keine echten Antwortinhalte gelesen oder weitergeleitet.
