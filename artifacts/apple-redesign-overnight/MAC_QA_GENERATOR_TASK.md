# Narrow next task: generated local Catalyst QA configuration

This task produces one generator script, not production app changes. Source is the current dirty `test` tree. Preserve original PBX, plist, entitlement, constants, schemes, settings, credentials and all Assistant/Connect work. Never launch an app, install profiles, fetch signing assets or perform releases.

Design Impact & Feature Reachability: Catalyst-only verification infrastructure. Uses actual current RN/native/editor resources, neutral surfaces and current Assistant. No new user setting or stored-note change. iPhone/iPad production builds unchanged. Synthetic fresh QA data only; no credential/pairing/broker migration. Actual Mac feature, width, light/dark, keyboard and accessibility verification follows signed isolation checks. Widget/Share AppGroup workflows remain UNVERIFIED under groupless QA.

Implement `apps/mobile/scripts/generate-redesign-qa.rb`, with xcodeproj gem, Ruby standard libraries and existing Node. Run locally with bundled CocoaPods Ruby/gem paths; do not install gems or pods. Coordinator will execute and inspect generated files and build the app. Worker needs only `ruby -c` and concise handoff. Do not write new fixtures or broader build tooling.

## Generator output (local ignored only)

Within apps/mobile/ios: sibling `VeyraNRedesignQA.xcodeproj`, `VeyraNRedesignQA.xcworkspace`, `.veyran-redesignqa/` (marker, QA entitlements, Info plists, Metro config, constants copy, source-hash receipt). All are appended to LOCAL `.git/info/exclude` by coordinator before running. Generator refuses if outputs are symlinks, outside root, or existing directories lack this task's ownership marker. Regeneration may update only these task-owned outputs. Do not edit Git configuration/metadata from script.

Load the CURRENT Notesnook.xcodeproj via Xcodeproj; save sibling project preserving UUIDs, source groups, paths, target names, dependencies, build phases, Pods base configs and existing uncommitted native integration. projectDirPath/projectRoot remain empty because sibling lives at same source root. Sibling workspace references generated project and existing Pods/Pods.xcodeproj. Copy shared schemes and replace ReferencedContainer only; original schemes unchanged. No pod install.

Generated target-specific host `Notesnook`, Share `Make Note`, Widget `NotesWidgetExtension` configs (Debug and Release):

- host bundle `com.ozel0t.veyran.redesignqa20261012`, share `.share`, widget `.widget`;
- `DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER=NO`, team `QXCNJY73A8`;
- manual Apple Development signing, certificate fingerprint `58A4018F522DC35ABA84C6632EBE4EF282045584`;
- existing wildcard Catalyst profile UUID `56abc356-284f-40a8-b7de-33cf28125a98`, name `Mac Catalyst Team Provisioning Profile: *` (coordinator revalidates local profile);
- target QA Info plist and entitlements paths, including sdk=macosx conditional values. Do not pass host entitlement/profile globally to Pods or extensions. Remove inherited target-level signing conditionals that conflict only in generated project.
- QA family variables IOS_MAIN_BUNDLE_ID/IOS_SHARE_BUNDLE_ID/IOS_WIDGET_BUNDLE_ID must resolve to QA values. Do not leak Production xcconfig values into signed targets.

Each generated entitlement declares sandbox, minimal original host permissions as needed, and SOLE Keychain group `QXCNJY73A8.com.ozel0t.veyran.redesignqa20261012`. NO AppGroup. Omit time-sensitive permission absent in local wildcard profile. Do not hardcode host application-identifier onto extension entitlements; let Xcode derive per-target IDs. All host/extensions signed identity/profile are independently checked before launch.

Copy current target Info plists via Xcodeproj plist utilities. Delete `appGroupId`, `ReactNativeQuickSQLite_AppGroup` entirely, including extensions. Remove CFBundleURLTypes and document-association handlers from QA family to avoid registering production nn/veyran/ShareMedia URLs. Set QA display name. Keep unrelated usage-description and source properties.

## QA-only Metro/constants overlay

RN bundle build supports BUNDLE_CONFIG. Set it only in QA host/share configs to generated `.veyran-redesignqa/metro.config.cjs`. Config requires original current `apps/mobile/metro.config.js`, preserves resolver behavior, delegates to original resolveRequest and then substitutes ONLY the resolved canonical `app/utils/constants.ts` sourceFile with generated QA constants copy. Put generated folder inside Metro projectRoot/watch reach.

Constants copy is regenerated from CURRENT dirty original, with exactly these narrow additions: import getBundleId from the already existing react-native-device-info import; replace ONLY getKeychainAccessGroup() in the generated copy with an exact QA host/share bundle allowlist, throw on any other identity, and return sole QA group. This QA-only helper must fail closed rather than return a production group. Original production file/function unchanged. Assert expected import/function text found exactly once; fail on ambiguous source. No other substitutions, no changes to original constants.ts, no general hardcoded production replacements. Current file has only package imports, so generated copy location does not break relative imports; verify this or refuse.

Catalyst hasAppGroupContainer() already false; native attachment/MMKV/SQLite own-container paths use missing plist keys. Native Connect/SIWC use default Keychain group; sole QA entitlement is essential. Do not copy personal credentials, reset keychains, touch production containers or configure broker connections.

## Completion

Generator is reviewable, Ruby syntax passes. Do not claim actual generation, signing, build, Mac runtime or Keychain roundtrip if not run. Coordinator owns all these checks. Open limitations: QA without AppGroup cannot prove native Share attachment copy/widget/alarm group workflows; record honestly, do not weaken production behavior.

Security pre-review completed (16 verified DeepSeek requests). Mandatory self-assertions: all host/share/widget target/config unconditional and SDK-conditional signing/Info/QA ID settings resolve to generated paths and exact QA values; all schemes/workspace references point to sibling/Pods only; plists have no AppGroup/SQLite/URL/document-type/UTI handlers; each generated entitlement has zero AppGroups and sole expected QA Keychain group. BUNDLE_CONFIG only host/share; wrapper delegates original resolver, substitutes exact canonical constants only. Do not erase source-file references simply because their filenames say Notesnook: active build settings and actual signed artifacts establish isolation. Widget also gets sole QA group per this task, disjoint from production; no widget workflow acceptance is claimed. Fail generation on assertion errors.
