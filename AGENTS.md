## Project-specific independent review gates

Use the global `ai-workers` bridge and its shared policy at `~/.ai-workers/bridge/policy.mjs`. Codex or Claude coordinates and independently verifies findings against this repository and tests. The review gates below remain project requirements.

- Before implementing a high-risk subsystem, call `deepseek_review` with `kind=architecture`.
- Before finalizing schema, sync, reminder/task, migration, or backup-format changes, call `deepseek_review` with `kind=migration`.
- For crypto boundaries, credentials, App Group, local persistence, or external-process changes, call `deepseek_review` with `kind=security`.
- Before declaring a major implementation complete, call `deepseek_review` with `kind=final`.

Use `deepseek_review` with `kind=diff` for significant diffs and `deepseek_review` with `kind=debug` for difficult failures. Prefer MCP over Computer Use. DeepSeek implementation runs in the bridge’s isolated checkout and is applied only after supervisor review. Bridge setup and fallback details are in `~/.ai-workers/README.md`.
