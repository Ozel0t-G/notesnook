# VeyraN internal TestFlight candidate QA — 2026-09-27/28

This report records the new candidates, not final App Store readiness. No `main` merge or production App Store submission occurred. Times are Europe/Oslo (CEST).

## Candidate distribution

| Gate | Status | Evidence |
| --- | --- | --- |
| iPhone/iPad distribution | **PASS** | Universal `3.4.16 (18)` from signed `c1273982b`, Xcode ARM64 archive, upload accepted September 27 at 22:24:30. September 28 live ASC UI shows upload **Complete**, Binary State **Validated**, ARM64 device family **iPhone, iPad**, and existing `Internal Pencil Beta` membership with one tester. The group reports **Installed 3.4.16 (18)** on September 28. The exact installed device and mobile functional behavior remain unverified. Hermes VM dSYM warning limits crash symbolication. |
| Mac package/upload | **PASS** | MAS `3.4.8 (1790539967)` from signed `1559b18e5`; signed arm64 app and installer, App Sandbox, team `QXCNJY73A8`, existing profile identity. Transporter delivered at 22:23 and reports `processingState: VALID`. |
| Mac internal availability/install | **PASS** | Native macOS TestFlight offered build `1790539967` as an Update. Installed `/Applications/VeyraN.app` reports `CFBundleVersion=1790539967`, `CFBundleShortVersionString=3.4.8`, `Authority=TestFlight Beta Distribution`, and team `QXCNJY73A8`. TestFlight then showed Open. No manual package was substituted. |

## App Store Connect follow-up — September 28

The user restored the Apple browser session. Mac `3.4.8 (1790539967)` also
shows upload **Complete** and the existing `Internal Pencil Beta` group with
one tester. Build-specific **What to Test** fields were empty for both current
candidates; the prepared QA checklist and guarded-account-flow limitations
were saved for iPhone/iPad and Mac, and each displayed **Saved**. No new
upload, tester invitation, group, Beta App Review submission, or App Store
release was performed.

The unfiltered Crash Feedback list has two September 25 reports for old Mac
`3.4.8 (1790320806)` and a September 19 report for old iOS `3.4.13 (2)`.
Neither current candidate appears in that list. Screenshot Feedback shows
**No Screenshot Feedback**. The group-level aggregate seven-crash count
does not establish a build-18 crash count from this view. This
snapshot does not prove crash-free use or replace device functional testing.

Live build records: [iPhone/iPad build 18](https://appstoreconnect.apple.com/teams/ba00d3c6-85d0-445e-b0d3-89d7e993c601/apps/6813860928/testflight/ios/0fcb5ddf-c78d-4a83-ab32-8417fca62582),
[Mac build 1790539967](https://appstoreconnect.apple.com/teams/ba00d3c6-85d0-445e-b0d3-89d7e993c601/apps/6813860928/testflight/macos/0a8fe238-d7d1-4c6f-b1a6-d7eb65b24da2).

## Actual Mac TestFlight ↔ production Web

The installed Mac TestFlight build and Chrome production Web used the approved disposable `ozel0t31820+veyranqa20260927@gmail.com` QA account. The user corrected the original mailbox spelling to `ozel0t31820@gmail.com` and approved that plus alias; the earlier `ozel031820@gmail.com` address is superseded. No credential or MFA code is stored here.

| Gate | Status | Evidence / limit |
| --- | --- | --- |
| Login/session | **PASS / PARTIAL PASS** | The Mac beta inherited the existing encrypted profile and authenticated session without deletion. Full quit/relaunch retained the session and notes twice. A fresh password/MFA login into this exact build was **NOT TESTED** because the account was already authenticated. |
| Branding/navigation/themes | **PASS** | Actual TestFlight UI shows VeyraN, Notes, Tasks, Settings, VeyraN Dark, VeyraN Light, and Auto/System; Light visibly applied, then Auto restored. No normal Notesnook theme card or Upgrade/Pro item was visible. Packaged renderer lacks `themes-api.notesnook.com`; offline packet-level theme independence was **NOT TESTED**. |
| Note round-trip | **PASS** | Mac created `VEYRAN-TF-QA-20260927-Mac-Web-roundtrip`; Web saw title/body after reload. Web changed title/body; Mac received both without app reload. Mac edited body again; Web received it without reload. Automatic UI updates were observed, but the exact event/poll transport was not proven. |
| Notebook/Tag | **PARTIAL PASS** | Mac created `VEYRAN-TF-QA-20260927-Notebook` and assigned the Note; Web showed the relation. Mac tag add and removal appeared in Web without reload. After archive/restore and Trash/restore, Mac temporarily showed notebook count `0` and empty notebook even while its Notes list retained the notebook chip; Web showed the Note correctly. A Mac app restart restored count/content to `1`, indicating stale Mac UI state rather than lost relation data. |
| Archive/Trash | **PASS with UI caveat above** | Mac archive, Web restore, Mac Move to Trash, and Web Restore all propagated automatically; counts changed as expected. |
| Attachments | **PASS** | Mac UI uploaded 53-byte `veyran-tf-qa-attachment-20260927.txt`; Web UI downloaded it with matching SHA-256 `cee4a4b289a11f3d48f4bdb3ce249845762cad246a1dd2cc857d52a56c558a13`. Web UI uploaded 41-byte `veyran-tf-qa-web-to-mac-20260927.txt`; Mac UI downloaded it with matching SHA-256 `544030c0d2721a98bab7c7c20d21e4dd88acf383b35aec5c7b015cdc2f7b063d`. Storage host was not separately attributed from the browser UI. |
| New public Share | **PASS** | Mac beta published a new VeyraN share. An anonymous separate browser showed the expected Note and VeyraN branding. HTML OG/Twitter metadata used HTTPS VeyraN URLs and the OG image endpoint returned JPEG 200. After Mac Unpublish, anonymous reload showed VeyraN 404. |
| Mac Tasks | **PASS for one client; DEFERRED TO PHYSICAL QA for two clients** | Created a Task in the existing QA List with description, High priority and flag; edited description/priority to Medium; it persisted across full Mac restart; completion moved it to Completed. Reminder date/time UI is present. The Mac UI explicitly says Urgent alarms are unavailable on macOS; iPhone alert behavior and two-client Task sync remain tomorrow's physical tests. Current Web has no standalone compatible Tasks UI. |
| Authenticated domains | **PARTIAL PASS** | Chrome Network showed production `veyran.northcore.space`, `api.veyran.northcore.space` (including Sync WebSocket), and `events.veyran.northcore.space` SSE. Anonymous Share used `share.veyran.northcore.space`. Normal theme use had no packaged `themes-api.notesnook.com` reference. No raw HAR was kept. Full Mac process/domain and file-host capture remains **NOT TESTED**; the optional Skiff image-import branch still contains `cors.notesnook.com` and was not exercised. SSE showed intermittent HTTP/2 protocol errors followed by 200 reconnects while functional Note sync passed. |

The production Web post-deploy Sync smoke also passed: a new Note created after the Sync-only dependency deployment retained its title/body after a full Web reload and showed `Synced now`; the Mac beta subsequently received it.

## Server/security and remaining gates

Production Sync runs `veyran/sync:c7734b9` from signed source `c7734b9`, removing obsolete direct Kestrel HTTPS 2.2 from the .NET 9 restore graph. Old image `veyran/sync:86547b47` and `/srv/infra/veyran/compose.pre-kestrel-20260927.yaml` remain for rollback. Container/public health, service tests, Compose/exposure checks and protected-route 401 checks passed. The separate infra runbook has signed updates `6f3d657` and `467aa98`.

No-key/keyed recovery remain HTTP 410; normal password and email change remain HTTP 503 before unsafe cross-service writes. OIDC HTTPS discovery and invalid-token rejection passed; fresh token issuance and natural refresh in the newly installed Mac beta were **NOT TESTED**. Remaining NuGet work includes compatible upgrades for MessagePack, MailKit/MimeKit, Scriban, and IdentityServer4; no broad package churn was deployed.

The Mac Profile screen still advertises “Change email address” despite the server's HTTP 503 guard. The guarded path was not invoked during QA. The visible copy should be corrected before a production release so users are not led into a disabled flow.

Physical iPhone/iPad, Apple Pencil/drawing, Widget cold completion, Urgent/Dynamic Island behavior, and two-client Tasks are **DEFERRED TO PHYSICAL QA**. Use [the checklist](../VEYRAN_TESTFLIGHT_PHYSICAL_QA.md). Final production readiness remains **FAIL**.

Screenshots: [installed Mac build](mac-testflight-build.jpg), [Mac Notes](mac-testflight-notes.jpg), [Mac Appearance](mac-testflight-appearance.jpg), [VeyraN Light](mac-testflight-light.jpg), [Mac Tasks](mac-testflight-tasks.jpg), [revoked Share](share-revoked.jpg), [production Web Appearance](web-appearance.jpg). Screenshots omit credentials and MFA codes.
