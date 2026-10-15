## Project-specific independent review gates

Use the global `ai-workers` bridge and its shared policy at `~/.ai-workers/bridge/policy.mjs`. Codex or Claude coordinates and independently verifies findings against this repository and tests. The review gates below remain project requirements.

- Before implementing a high-risk subsystem, call `deepseek_review` with `kind=architecture`.
- Before finalizing schema, sync, reminder/task, migration, or backup-format changes, call `deepseek_review` with `kind=migration`.
- For crypto boundaries, credentials, App Group, local persistence, or external-process changes, call `deepseek_review` with `kind=security`.
- Before declaring a major implementation complete, call `deepseek_review` with `kind=final`.

Use `deepseek_review` with `kind=diff` for significant diffs and `deepseek_review` with `kind=debug` for difficult failures. Prefer MCP over Computer Use. DeepSeek implementation runs in the bridge’s isolated checkout and is applied only after supervisor review. Bridge setup and fallback details are in `~/.ai-workers/README.md`.

## Test accounts and Apple test devices

- The user tests TestFlight builds on real Apple hardware with their personal account. Agents must not operate real devices or the installed TestFlight app.
- Agents use the dedicated account `codex+ozel0t31820@gmail.com` for their own app tests in iOS/iPadOS simulators. Never use the user's personal account for agent-created test data.
- When macOS app testing is necessary, build and launch a fresh local Mac app. Never test in the installed TestFlight version. Verify that the local build uses an isolated app container/profile before signing in with the dedicated test account; a different `.app` path alone does not isolate data.
- The user authorized looking up account verification codes in Apple Mail for this test-account setup. Keep passwords and one-time codes out of repository files, logs, and test fixtures. Do not store them in this file.

# ADD THIS SECTION TO THE EXISTING ROOT AGENTS.md (MERGE, DO NOT REPLACE)

## PERMANENT VEYRAN DESIGN + FEATURE-PARITY POLICY — MANDATORY FOR ALL FUTURE AGENTS

**Before starting ANY change touching UI, navigation, settings, editor, rendering, themes, assistant, tasks, onboarding, widgets, integrations, or user-visible behavior:**
1. Read `AGENTS.md` fully (including existing ai-workers/DeepSeek review and real-device rules).
2. Read `docs/APPLE_DESIGN_SYSTEM.md` fully. Read `docs/UI_FEATURE_PARITY_MATRIX.md` and `docs/NEW_FEATURE_DESIGN_GATE.md` for affected areas.
3. Check the current `test` worktree, uncommitted changes, existing components and mockup references. Never overwrite local work or treat an old reference SHA as HEAD.
4. Write a short **Design Impact & Feature Reachability** note in the task plan: platform(s), affected design tokens, entry points, actions, light/dark, iPad widths, Mac window sizes, accessibility, localization, data/permission safety, existing feature parity, tests.
5. Reuse platform-specific Apple components and shared semantic design tokens. No ad-hoc one-off colors/surfaces, Material/Android-styled icons, font-size hardcodes or unbounded full-width desktop forms without documented exception.
6. **No disappearing features:** every existing user action and persisted setting must remain reachable and function correctly. If compact UI hides it, give it a clearly labeled secondary location and update `docs/UI_FEATURE_PARITY_MATRIX.md`. Never silently remove source-supported actions.
7. **Settings contract:** every visible setting must have an actual functional effect in the active runtime and reflect persistent state, or be clearly marked unsupported/disabled with a truthful explanation. No dummy rows or ignored controls. Verify app restart, system appearance changes and setting migration.
8. **Separate color domains:** app accent ≠ selected text highlight ≠ text foreground ≠ semantic warning/success/destructive ≠ notebook/task-list colors. Text highlight must never call `setAccentColor()` or recolor app chrome. Support warm orange marker swatch with accessible text contrast.
9. New features must supply native-feeling UI for **iPhone + iPad + current Mac Catalyst** as applicable; responsive states, Light/Dark, pointer and keyboard, Dynamic Type, VoiceOver, focus, loading/empty/error/disabled, permissions and localization. When deliberately platform-specific, document why and preserve the other clients.
10. Privacy and security are part of UI: never display auth subject/client identifiers, tokens, credentials or raw document HTML by default; never automatically transmit private notes to AI; respect scope/capabilities and explicit confirmation for writes.
11. For Assistant/sidebar, use the same semantic surfaces and spacing as editor/sidebar; real collapsible/resizable behavior, dedicated content preview renderer, clear request/response/status and action confirmations; do not let the panel crush the writing surface.
12. Preserve encryption, sync, stored note content/formatting, attachments, recovery, alarms, shortcuts, PencilKit and WEB CONTENT compatibility. No hidden migration or resets to achieve appearance.
13. Testing gate: actually build/run relevant supported targets, collect representative real screenshots and compare to approved references; ensure new-feature UI behavior works, not just compile. Add/update tests for positive/negative routes, appearance isolation and setting persistence. Mark unrun checks as UNVERIFIED.
14. Before declaring completion, run the repository's required `deepseek_review` gates for architecture/migration/security/final as applicable, follow the global ai-workers bridge, and independently verify outcomes.
15. No pushes, PRs, commits, TestFlight or App Store distribution without explicit new authorization. Work only on `test` or established isolated agents' checkouts; keep a local checkpoint and handoff.

**If a future instruction conflicts with these enduring rules**, preserve the user-requested functionality and data first; surface and document the conflict. A design change is not done while existing functionality is inaccessible or configured controls are ignored. This policy is not optional and applies to changes made by subagents, generated code and refactors.

## Nutzerautorisierung: zusätzliches echtes Anthropic Claude

Seit dem ausdrücklichen Nutzerauftrag vom2026-10-13 darf echtes Anthropic Claude zusätzlich zu DeepSeek implementieren, auch bei FORCE. Codex bleibt Koordinator/Reviewer. Keine parallelen Änderungen gleicher Dateien. Vorhandene DeepSeek-Pflichtreviews und Sicherheitsgrenzen bleiben verbindlich. claude_review_*-Aliase sind DeepSeek und dürfen nicht als Anthropic-Nutzung dargestellt werden. Nachgewiesener lokaler Weg und Limitübergabe: [docs/CLAUDE_OFFLOADING.md](docs/CLAUDE_OFFLOADING.md). Keine vorsorgliche Limitdrosselung; bei tatsächlichem Claude-Limit aktuellen begrenzten Stand an DeepSeek übergeben, nach nachgewiesenem Reset beide erneut nutzen.

## Temporary Master-V2 execution exception

Explicit user authorization, 2026-10-14: for this repository's remaining VeyraN Master-V2 redesign, Codex may and should directly implement cohesive UI changes, integration fixes and related tests, including while the persisted worker mode is FORCE. The exclusive worker implementation and coordinator-only restrictions are temporarily superseded for this assignment; worker failure or a turnlimit is not a prerequisite. DeepSeek and genuine Anthropic Claude remain available for suitable independent tasks and the required independent reviews.

This exception expires when the assignment is complete or the user revokes it; the general delegation rule then applies again. All existing design, security, privacy, test, independent review and QA isolation requirements remain in force. Preserve local changes, finish or safely hand over active writers before editing their files, work locally on `test`, and do not commit, push, create PRs, deploy or upload. Connect remains deferred; only its existing Inspector geometry may change to protect the core editor. Do not alter global ai-workers policy/configuration, remove locks, bypass protections or add an AGENTS.override.md.


## Temporary Master-V2 accessibility prioritization — 2026-10-15

Explicit user direction until the Saturday17October2026 evening deadline: additional VoiceOver audits, screenreader optimizations, extended Dynamic Type verification and accessibility-specific test cycles are **DEFERRED**. Do not classify them as failed mandatory acceptance or release blockers. Preserve existing accessibility features and labels; never intentionally degrade them. Ordinary keyboard operation, readable text, adequate contrast and functional navigation remain regular quality requirements. Existing independent review, security, isolation, data-integrity and feature-parity rules remain in effect. Focus remaining time on Apple redesign, parity and stability; no new overall audit. This bounded instruction supersedes the earlier requirement to run those extensive accessibility checks during this deadline window.
