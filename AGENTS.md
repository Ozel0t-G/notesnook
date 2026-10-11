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
