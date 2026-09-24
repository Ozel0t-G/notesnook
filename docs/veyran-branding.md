# VeyraN brand and identifier migration plan

Updated 2026-09-24 on `test`. The user selected **VeyraN** after research found the bare **Veyra** App Store name occupied and a directly overlapping **Veyra Notes** app. No App Store Connect name reservation or trademark clearance is claimed. No remote rename, push, TestFlight upload, or App Store submission is part of this change.

## Public-name validation

Apple's public search found no app titled VeyraN in the US, Norway, Australia, or UK, but [an Apple developer named Veyran](https://apps.apple.com/us/developer/veyran/id1812510450) exists. The closely named [Veyrn task-management app](https://apps.apple.com/us/app/veyrn/id6764057920) is already listed in Productivity on iPhone, iPad, and Mac, which adds practical category-overlap risk. The [Veyran GitHub account](https://github.com/Veyran) is occupied; repository names under this fork's owner are separately scoped. Prefer `veyran` for the repository if available to the owner, then `veyran-app`. Neither availability nor ownership of private repositories was confirmed.

Registry checks returned no registration record for [veyran.app](https://pubapi.registry.google/rdap/domain/veyran.app), [veyran.dev](https://pubapi.registry.google/rdap/domain/veyran.dev), or [getveyran.com](https://rdap.verisign.com/com/v1/domain/getveyran.com). These appear unregistered, subject to a registrar check. [veyran.io](https://rdap.identitydigital.services/rdap/domain/veyran.io) and [veyran.com](https://rdap.verisign.com/com/v1/domain/veyran.com) are registered. No domain was purchased. `veyran.app` is the preferred candidate if it can be acquired and used lawfully.

The bare Veyra name is already used by an [App Store app](https://apps.apple.com/us/app/veyra/id6749780946), a [Veyra Notes app](https://apps.apple.com/jp/app/veyra-notes/id6803140421), and a [software service with notes and tasks](https://veyra.to/). VeyraN still has material similarity risk: Veyran is an existing developer/company identity, Veyrn overlaps in Task functionality, and Veyran Systems Inc. filed US [VEYRA ONE, serial 99731168](https://tsdr.uspto.gov/#caseNumber=99731168&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch) for mobile scheduling software and related services. This public check is not legal clearance. Seek professional trademark review before a public launch. Apple's [app-name rule](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app) and App Store Connect are authoritative for reserving the title.

## Canonical presentation

| Surface | VeyraN value | Status |
| --- | --- | --- |
| iPhone/iPad display name | `VeyraN` | Set in active and pencil xcconfigs; TestFlight archive script copies pencil over active. |
| Electron `productName` and package label | `VeyraN` | Set in package and builder; old app ID, internal app name, and user-data directory stay for encrypted-profile continuity. |
| Settings/About | `About VeyraN`; provenance in Licenses | Implemented while version/build and third-party notices remain. |
| App Store Connect/TestFlight app-record name | `VeyraN` | Manual, unconfirmed; binary display name alone does not rename the record. |
| GitHub repository | `veyran`, fallback `veyran-app` | Recommendation only. |
| Custom scheme | `veyran://` | Accepted alongside `ShareMedia://` and `nn://`; see routes below. |

Do not globally rename `@notesnook/*` packages, source directories, encrypted record names, service endpoints, database keys, App Lock sentinel, copyright headers, or provider-specific subscription labels.

## Canonical icon and derivatives

The supplied Icon Composer directory is preserved without modification at `apps/mobile/ios/Notesnook/AppIcon.icon/` (11 files: `icon.json` and 10 SVG layers; light/dark specializations). Its `icon.json` SHA-256 is `372a57e9bec8d1ffc5879da48f0d25797a5a4beb635d071ffcc9a0bc7757eace`. It is the **editable master**. Xcode 27's host target includes it as an icon-composer resource named `AppIcon`; `ASSETCATALOG_COMPILER_APPICON_NAME` remains `AppIcon`. Apple's [Icon Composer workflow](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer) says Xcode chooses a same-named `.icon` over the older `AppIcon.appiconset` and creates older-OS renditions. The old set remains temporarily for validation; it is not an alternate master.

The Widget's `resources/icon.png`, React Native splash/Settings mark, Electron `app.icns`, `app.ico`, sized PNGs, DMG, and web favicons are separate consumers. The supplied 1024-pixel Icon Composer preview exports are stored under `resources/branding/veyran/` and clearly marked as derivatives. Run `node scripts/generate-veyran-icons.mjs` on a Mac with release Xcode 27 to regenerate them: the script asks `actool` for the macOS ICNS **directly from `.icon`**, then uses the supplied preview exports for required PNG and ICO sizes. The `.icon` remains the sole editable master. The old Notesnook in-app logo was replaced on inspected app-brand surfaces; provider-specific subscription branding remains attributed to Notesnook.

## Stable identifiers and migration

| Identifier | Current value | Decision |
| --- | --- | --- |
| Main iOS bundle | `com.ozel0t.note.notesnookpencil` | Keep for upgrade and TestFlight continuity. |
| Widget bundle | `com.ozel0t.note.notesnookpencil.widget` | Keep. |
| Make Note extension bundle | `com.ozel0t.note.notesnookpencil.share` | Keep. |
| App Group | `group.com.ozel0t.note.notesnookpencil` | Keep across host, widget, share, native bridge and SQLite. |
| Keychain group/service | Current `com.ozel0t.note.notesnookpencil` family and service strings in `encryption.ts` | Keep; these protect the encrypted database key and session. |
| Electron app ID | `org.streetwriters.notesnook` | Keep pending signing/update migration. |
| Electron user data/keyring name | existing `Notesnook` directory and internal app name | Pinned before config/database imports when `CUSTOM_USER_DATA_DIR` is absent; package/CFBundleName stays VeyraN. |
| Backup UTI and `.nnbackup` | `com.ozel0t.note.notesnookpencil.nnbackup` | Keep for import compatibility; display label may change. |
| Task carrier/Widget schema | existing settingitem namespace, snapshot v3 `dueDate`/`dueTime` | Keep for sync and decoder compatibility. |

A future bundle family must use a verified owned reverse-DNS root: `com.<verified-owned-root>.veyran`, `.widget`, `.share`; the corresponding App Group and Keychain groups need explicit transition design. Changing the host bundle ID creates a different app and App Store Connect record, not an in-place rename. Before any such step: confirm team/root ownership, provisioning and extension entitlements; design encrypted-data export/import and login handoff; test old/new app coexistence; preserve/transfer queued widget completions and alarm ownership; verify notifications, Keychain and App Group data; test backup import and live sync. Do this as a separate migration.

## URL route map

| Existing route | Purpose/consumer | VeyraN route | Legacy alias |
| --- | --- | --- | --- |
| `ShareMedia://QuickNoteWidget` | Widget quick note → mobile editor | `veyran://quick-add` | Keep and emit from existing widgets. |
| `ShareMedia://TasksWidget` | Widget Task list | `veyran://tasks` | Keep. |
| `ShareMedia://NewTaskWidget` | Widget new Task | `veyran://task/new` | Keep. |
| `ShareMedia://TaskWidget?id=<id>` | Widget Task detail | `veyran://task/<id>` | Keep. |
| `ShareMedia://CompleteTaskWidget?id=<id>` | Validated queued Task completion | No public custom-scheme equivalent in V1; a state-changing URL needs separate authorization design | Keep. |
| `ShareMedia://RemindersWidget`, `NewReminderWidget`, `ReminderWidget?id=` | Legacy widget compatibility | Task routes above | Keep. |
| `nn://note|notebook|tag|color/<id>` | Embedded content and desktop/mobile internal links | `veyran://<type>/<id>` accepted | Keep `nn://` as generated/stored syntax. |
| `https://app.notesnook.com/open_*`, account/verified | Upstream service/universal-link compatibility | None until owned domain and associated-domains setup | Keep. |
| Notifee `{type:'task', taskId}` | Notification tap/cold start | Remains structured payload | No URL migration. |

`veyran://settings` and `veyran://list/<id>` are **proposed only**; these routes do not yet exist. New public schemes are not authentication: Task IDs pass the existing validator and account-scoped pending-action path. Do not switch old widget emissions or remove old schemes before upgrade and cold-start smoke tests. Desktop supports `veyran://tasks`, `veyran://task/new`, and `veyran://task/<id>` plus note/internal links; desktop completion is not implemented.

The new scheme is registered for iOS and packaged desktop builds. Android's manifest still declares its older schemes and is outside this Apple/Desktop V1 release; do not publish Android `veyran://` links until it is registered and tested there. On desktop, Task detail navigation waits for the renderer's Task snapshot, so cold-start routing while signed out remains a validation item before public distribution.

On Linux, the package now declares both `x-scheme-handler/nn` and `x-scheme-handler/veyran`; a Linux package and OS activation test remain outstanding. On Windows, electron-builder derives the NSIS upgrade GUID from the unchanged `appId` ([builder documentation](https://www.electron.build/nsis/#guid-vs-application-name)); the visible product name can change without a GUID migration, although an actual old-to-new installer update was not tested here. The upstream Notesnook desktop update feed and GitHub publisher have been disabled in the VeyraN build; Settings hides desktop update and release-track controls until a VeyraN-owned, signed update feed is designed and tested.

## User-facing string classification

| Class | Examples and action |
| --- | --- |
| A — product presentation | Display name, widget header/refresh prompt, alarm privacy title, app menu/tray/window title, Settings About, native permission text → VeyraN. |
| B — attribution | `LICENSE`, Streetwriters copyright headers, upstream Notesnook credit and source links → preserve and identify clearly. |
| C — stable technical names | `@notesnook/*`, crypto/App Lock sentinel `notesnook`, App Group, Keychain, settingitem IDs, `.nnbackup`, `nn://` stored links → preserve. |
| D — service/ownership migration | Notesnook Pro billing, Streetwriters support/privacy/terms, upstream update/download/review URLs, backup folders, unowned website metadata, reusable in-app logo → retain provenance and resolve before public launch. |

## App Store Connect and release checklist

The private app record was previously named `Notesnook Pencil Beta` and uses `com.ozel0t.note.notesnookpencil`. In App Store Connect, inspect and eventually set the app-record name to VeyraN in each desired localization, confirm bundle association, and review subtitle, primary language, support URL, privacy URL, marketing URL, beta description, screenshots, keywords, and icon. Keep the existing SKU unless an account-specific reason requires a new record; SKU is not a display name. The built binary's `CFBundleDisplayName` controls the home-screen label; the app-record name controls App Store/TestFlight listing surfaces. Confirm both in a processed build. Do not upload or publish automatically.

For this private TestFlight channel, `scripts/build-pencil-testflight.sh` copies `ios-build.pencil.xcconfig` into `ios-build.active.xcconfig`; both contain `APP_DISPLAY_NAME = VeyraN`. The separate upstream production/staging xcconfigs still say Notesnook and are not VeyraN distribution inputs. Check the active config and bundle ID at archive time before any upload.

Before another distribution, validate iPhone/iPad icon appearances and widget/share branding, macOS package/profile continuity, all route aliases on cold and warm start, licenses and corresponding source access. Review the GPLv3/App Store distribution question and the trademark risk with qualified counsel. Release Xcode 27 is `/Applications/Xcode.app/Contents/Developer`; the selected global Xcode path currently points at beta 6.

## Validation performed in this worktree

- Release Xcode 27 `NotesnookRelease` ARM64 iOS Simulator build succeeded, including the host, Widget, and Make Note extension. The compiled main label is `VeyraN`, Widget label is `VeyraN Widget`, and compiled iPhone/iPad icon renditions show the supplied artwork. The app launched on iPhone 18 Pro and iPad Pro 13-inch (M5) simulators; the iPhone Home Screen showed the VeyraN icon and label in light and dark system appearance. Dark and tinted **icon appearance modes** were inspected in the supplied Icon Composer previews, not selected on an actual Home Screen. No Liquid Glass behavior beyond the supported `.icon` build path is claimed.
- Mobile and desktop TypeScript checks passed. Focused core internal-link tests (8) and mobile Widget-link tests (7) passed. `git diff --check` passed. `@notesnook/intl` and the desktop Web renderer built.
- Electron ARM64 macOS directory packaging succeeded. The packaged `VeyraN.app` has the new ICNS, `CFBundleName = VeyraN`, existing bundle ID, and both URL schemes. An isolated packaged launch showed title `VeyraN` while `app.getName()` remained `Notesnook` and the test profile stayed in its isolated directory. Electron's application menu reported `VeyraN`, `About VeyraN`, `Hide VeyraN`, and `Quit VeyraN`.
- `simctl openurl` invoked the new and legacy iOS schemes, but iOS displayed its external-link confirmation sheet, so that command alone did **not** verify in-app Task routing. Authenticated Task-link, actual Widget tap, TestFlight-processed name, signed upgrade, Windows/Linux packages, and live encrypted-profile upgrade remain untested.

## Independent review record

Read-only Claude architecture review preceded the implementation. Security review found the Electron keyring-name continuity risk; pinning `app.setName("Notesnook")` beside the profile path addressed it. It also flagged a newly public state-changing Task completion URL, which was removed while the existing Widget alias remained. A final review found the macOS menu label and Linux MIME gap; both were fixed and the packaged menu was inspected. A targeted diff review found custom-scheme hostname case handling and a second-instance startup race; both were fixed. The final focused review confirmed the upstream updater lockout and these fixes, then identified a narrow rapid-activation route-order risk, addressed by serializing Task route application. Claude's concern that the `/tasks` pathname might need a hash was checked against the renderer's real `/tasks` route and did not require a change.
