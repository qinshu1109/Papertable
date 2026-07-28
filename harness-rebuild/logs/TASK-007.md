# TASK-007 execution log

- Branch: `task/TASK-007-protocol-repair`
- Started: `2026-07-28T12:35:24+08:00`
- Status: `in_progress`
- WenzMark task ID: `87d16e14-3168-4c84-9466-d58d7378c876`

## Checkpoints

- `2026-07-28T12:35:24+08:00` — Confirmed the requested branch at base `7da5829`; preserved the pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/`.
- `2026-07-28T12:35:24+08:00` — Read the required workspace context, TASK-003 through TASK-006 cards/logs/outputs, accepted ADR-005/ADR-007, specified research sections, and the relevant Agent, provider, capability, Rust LLM/note, event persistence, and test code directly in the requested order.
- `2026-07-28T12:57:32+08:00` — Added the explicit provider classification table: unauthorized/configuration fails without retry; rate limit retries twice with `250/750ms` bounded backoff; 5xx/upstream/disconnect/timeout/empty retries at most twice; malformed protocol enters repair without a raw transport retry. Every provider attempt consumes the existing TASK-005 ledger.
- `2026-07-28T12:57:32+08:00` — Added deterministic tool protocol handling: NFKC, zero-width removal, full-width/protocol-tag detection, and in-order lossless argument-fragment assembly. Missing names/ids, incomplete JSON, ambiguous values, and protocol tags are never guessed, completed, or executed.
- `2026-07-28T12:57:32+08:00` — Added the bounded same-model/same-protocol repair chain: native-tools resend, same-protocol non-stream rebuild, matching capability-cache invalidation/re-probe, and retry from the stable message checkpoint. Only exhaustion produces `failed/protocol_error`.
- `2026-07-28T12:57:32+08:00` — Moved read authority into Rust/SQLite schema version 9. Rust records the exact current-run/current-project search result allowlist and rejects unsearched, cross-run, cross-project, stale-scope, frontend `readableIds`, model scope, library, and path bypasses.
- `2026-07-28T12:57:32+08:00` — Disabled the Agent H-path `searchMetadataContext` invocation; retained the uncalled helper for TASK-011 physical deletion.
- `2026-07-28T12:57:32+08:00` — Persisted retries, deterministic repair, resend, read/search requests and completions, capability invalidation/re-probe, rejection, final synthesis, and terminal transitions through the existing append-only event/checkpoint transaction using schema v1 vocabulary.
- `2026-07-28T13:03:04+08:00` — Supervisor review corrected the audit semantic flag: only NFKC/zero-width cleanup and lossless fragment reassembly are `deterministic: true`; resend, re-probe, rejection, and observed outcomes remain recorded but are `deterministic: false`.

## Tests

- `pnpm exec tsx --test src/lib/agent.test.ts src/lib/agentNoProgress.test.ts src/lib/agentProtocolRepair.test.ts src/lib/agentProtocolPipeline.test.ts src/lib/agentBudgetAudit.test.ts src/lib/storage/dexie.test.ts src/lib/provider/http.test.ts server/cozai.test.mjs` — PASS, 87/87.
- `pnpm typecheck && pnpm exec tsx --test src/lib/agentProtocolRepair.test.ts src/lib/agentProtocolPipeline.test.ts src/lib/storage/dexie.test.ts` — PASS, 39/39 after final implementation.
- `pnpm verify` — PASS: typecheck, ESLint, Prettier, 201/201 TS/Node tests, 84/84 Rust tests, and production Vite build.
- `/Users/qinshu/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml --check && /Users/qinshu/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` — PASS.
- `pnpm test:e2e` — PASS, 29/29 Playwright tests.
- `python3 /Users/qinshu/.codex/skills/init-ai-project-workspace/scripts/workspace_builder.py validate --root .../papertable/harness-rebuild` — PASS (`ok: true`, L2, no errors).
- `jq -e` syntax plus fail-fast TASK-007 invariant checks over every `outputs/task-007/*.json` fixture — PASS.
- `git diff --check` — PASS.
- Supervisor independent replay after the semantic correction — PASS: 41/41 focused protocol/persistence tests, 201/201 full TS/Node tests, 84/84 Rust tests, typecheck, lint, formatting, and production build.
- Supervisor Rust boundary replay — PASS: current-run allowlist rejection/persistence 2/2, v9 migration 1/1, crash/reopen transaction 1/1.

## Scope audit

- Branch remained `task/TASK-007-protocol-repair`; no branch switch, commit, push, PR, merge, staging, or dependency/manifest change.
- `git diff --cached --name-only` is empty.
- Preserved `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/` as pre-existing untracked user artifacts.
- `rg -n 'searchMetadataContext\(' src/lib/agent.ts` returns only the helper definition; there is no legacy H-path invocation.
- Tool authority remains exactly `search_notes` and `read_notes`; the re-probe rejects non-native capability and does not downgrade to prompt tools.
- Event schema remains version 1; only the SQLite user version advances to 9 for the Rust-owned run allowlist.
- Source-note reads remain read-only. The only new data mutation is append/insert of audit authority rows keyed by an active Agent run.
- TASK-007 replay inventory contains `README.md`, `retry-classification.json`, `ambiguous-repair-success.json`, `repair-exhausted-protocol-error.json`, `rust-run-allowlist.json`, and `persistence-reopen.json`.

## Unresolved risks

- No live third-party provider was called; every classification and repair branch is covered by deterministic fake-provider/injection tests.
- Vite still reports the pre-existing `main` chunk size warning; build succeeds and TASK-007 does not broaden bundle scope.
- Workspace validation reports the standard accepted-ADR confirmation warnings for ADR-001 through ADR-007, with zero structural errors.
- PR/CI/merge closure remains; no implementation or verification blocker remains.

## Acceptance

- `2026-07-28T13:03:04+08:00` — Supervisor technical acceptance PASS after source review, WenzMark/process/database reconciliation, independent test replay, and the deterministic-audit correction. Keep the task `in_progress` until PR/CI/merge and WenzMark closure are complete.
