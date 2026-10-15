# UI Design and Feature Gate — mandatory before every new feature or user-visible change

Copy this checklist into each Codex work plan and check every relevant item. Link its verification to actual screenshot/test artifacts. The gate applies to Codex, DeepSeek and every subagent; it is enforceable by project AGENTS.md and should be backed with lightweight lint/regression tests.

## BEFORE writing code
- [ ] Read root AGENTS.md and docs/APPLE_DESIGN_SYSTEM.md + docs/UI_FEATURE_PARITY_MATRIX.md.
- [ ] Identify actual active rendering and storage paths for iPhone, iPad and Mac Catalyst. Inspect the current `test` local changes first.
- [ ] Identify user journeys and where each action lives in UI and keyboard context. No lost features.
- [ ] Define loading, empty, pending, success, permission-denied, offline, error and disabled states, and truthful user copy.
- [ ] Define light/dark neutral surfaces, app accent separate from editor highlight and status colors, and responsive size/density.
- [ ] Define sensitive-content handling, consent before AI requests, permission guards for write-back, storage and log redaction.
- [ ] Define actual test assertions and baseline screenshots on affected platforms.

## DURING implementation
- [ ] Reuse shared semantic tokens and native SF Symbols, no ad hoc brand wash, no unrelated design library or platform-foreign widgets.
- [ ] Preserve custom themes, saved user data/formatting and existing settings. Every exposed setting has a working consumer.
- [ ] Document new setting key, default, scope, persistence, migration and feature flag.
- [ ] Preserve pointer/keyboard/touch/VoiceOver support and responsive column widths.
- [ ] Update functional action registry and add accessibility labels. New features must not drop previously registered tools.
- [ ] Apply existing ai-workers and DeepSeek project architecture/security/review gates.

## BEFORE completion
- [ ] Build/launch actual affected targets in isolated environments. Test Light/Dark, app/system mismatch, width/font scaling, input modalities and state transitions.
- [ ] Verify visible action paths and test representative end-to-end interactions. No simulated click-only proof for editor changes.
- [ ] Run automated tests; record passed, failed and blocked separately; visual compare real screenshots to approved mockups.
- [ ] Re-run editor note linking, toolbar configuration, highlight isolation, tasks, sync and assistant privacy smoke tests when touching shared UI.
- [ ] Update docs/UI_FEATURE_PARITY_MATRIX.md, screenshots and rationale for exceptions.
- [ ] Document exact diff, results and remaining issues. No release/push/PR/TestFlight without explicit consent.

### Suggested automated enforcement
- Unit test effective VeyraN standard themes for *neutral* `window/list/editor` surface isolation across accent choices, both modes.
- Unit test editor selected-text Highlight command never calls useThemeStore.setAccentColor, and accent selection never writes text-style marks.
- Unit test user toolbar settings produce the rendered visible configured groups per platform, and every tool ID maps to a valid, localized string.
- Generate a registry diff snapshot: fail CI/dev checks if a previously reachable tool disappears without an explicit migration/remapped UI entry and test.
- Snapshot theme/size variants with deterministic synthetic notes, capture genuine device/simulator screenshots for approval; CI output must not contain private user data.
- Add basic UI navigation test from settings to changed user-visible controls, and back; ensure changed values take effect after restart.
