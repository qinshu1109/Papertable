# TASK-005 execution log

- Branch: `task/TASK-005-budget-ledger`
- Started: `2026-07-28T11:43:13+08:00`
- Status: `in_progress`
- WenzMark task ID: `182004b9-d279-4f63-bc8a-dc5b713f1bb1`

## Checkpoints

- `2026-07-28T11:43:13+08:00` — Confirmed the requested branch and preserved the pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/` files.
- `2026-07-28T11:43:13+08:00` — Read the required workspace context, TASK-004 dependency card/log/outputs, and accepted ADR-002/ADR-003/ADR-006 directly.
- `2026-07-28T11:48:00+08:00` — Replaced the native loop constants with a run-owned four-dimensional ledger containing limits, used, remaining, token-reporting state, exhaustion reason, and append-only records.
- `2026-07-28T11:50:00+08:00` — Preserved Agent event schema v1 while wiring `exploration-started`, `budget-added`, and `terminal` events to the existing transactional run checkpoint through Web/Dexie and Tauri/SQLite storage.
- `2026-07-28T11:52:00+08:00` — Added real OpenAI-compatible usage normalization and transport for Node SSE/non-streaming and Rust/Tauri streaming/non-streaming paths. Missing or mixed usage remains explicitly `unreported`/`partial`; no token estimate is manufactured.
- `2026-07-28T11:55:00+08:00` — Added four-dimensional success exhaustion tests, four-dimensional exhausted-repair protocol-error coverage, remaining invariants, append audit, persistence/reopen, Rust crash recovery, transport parity, and hard-coded constant removal checks.
- `2026-07-28T11:57:49+08:00` — Added and validated five TASK-013 replay fixtures; completed formatting, clippy, E2E, L2 workspace validation, diff, branch, staging, preserved-file, and scope audits.
- `2026-07-28T11:59:00+08:00` — Final `pnpm verify` passed after adding the full repair-exhaustion matrix. The card remains `in_progress` for supervisor acceptance.
- `2026-07-28T12:08:00+08:00` — Supervisor review found one audit gap: an in-flight wall timeout wrapped as `AgentRunFailure` could bypass the `wall_exhausted` ledger marker. The catch order was corrected and a deterministic regression was added.
- `2026-07-28T12:09:00+08:00` — Supervisor independently reran the focused 26-test budget suite, full `pnpm verify` (172 JS/TS/server + 82 Rust), Rust clippy with warnings denied, 29 Playwright cases, workspace validation, and diff checks. All passed; accepted for PR.

## Tests

- `pnpm exec tsx --test src/lib/agentBudget.test.ts src/lib/agentBudgetAudit.test.ts src/lib/agent.test.ts src/lib/agentStateMachine.test.ts src/lib/agentTerminal.test.ts src/lib/agentEvents.test.ts src/lib/storage/dexie.test.ts src/lib/provider/http.test.ts server/cozai.test.mjs` — PASS, 87/87 before the final repair-matrix expansion.
- `pnpm exec tsx --test src/lib/agent.test.ts src/lib/agentBudget.test.ts src/lib/agentBudgetAudit.test.ts` — PASS, 25/25 including calls/tokens/wall exhausted-repair failures.
- `pnpm verify` — first run stopped at Prettier on the new Dexie test; formatted that file and reran. Final run PASS: typecheck, ESLint, repository Prettier, 171/171 JS/TS/server tests, 82/82 Rust tests, and production build. Vite emitted only the existing chunk-size advisory.
- `/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml llm::tests -- --nocapture` — PASS, 15/15 provider transport tests.
- `/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml every_agent_step_boundary_survives_crash_and_reopen_without_partial_rows -- --nocapture` — PASS, crash/reopen at all three transactional boundaries.
- `/Users/qinshu/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` — PASS.
- `/Users/qinshu/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — PASS.
- `pnpm test:e2e` — PASS, 29/29 Playwright tests.
- `python3 /Users/qinshu/.codex/skills/init-ai-project-workspace/scripts/workspace_builder.py validate --root .../harness-rebuild` — PASS (`ok: true`, zero errors). Seven warnings only request checking the already-recorded user confirmation for accepted ADR-001–007.
- `jq -e` syntax and invariant checks for every `outputs/task-005/*.json` fixture — PASS.
- `rg -n "MAX_TOOL_ROUNDS|MAX_TOOL_CALLS|MAX_WALL_MS" src server src-tauri --glob '*.{ts,tsx,mjs,rs}' --glob '!*.test.ts'` — no production matches.
- `git diff --check` — PASS.

## Scope audit

- Changed only TASK-005 task/log/fixtures, the Agent budget/runtime/event types and tests, the existing store audit wiring, provider usage transports and tests, and Rust transport/crash-recovery tests.
- Preserved `AGENT_EVENT_SCHEMA_VERSION = 1`, the TASK-003 event vocabulary, insert-only event storage, transactional event+checkpoint writes, legacy-turn read behavior, and SQLite schema/user version.
- Preserved TASK-004's terminal constructor and protocol-repair boundary: successful budget synthesis is `partial/<dimension>_exhausted`; exhausted repair is `failed/protocol_error`, evidence remains attached, and no answer token is emitted.
- Preserved `controlledCitations`, `readableIds`, host-frozen library scope, Rust tool whitelist, provider secret boundaries, and all seven read-only layers.
- No dependency manifest, lockfile, database DDL, attachment path, duplicate-call detector, or TASK-008 consumer was changed.
- `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/` remain untracked and untouched.
- Branch remains `task/TASK-005-budget-ledger`; `git diff --cached --name-only` is empty. Nothing is staged or committed.

## Unresolved risks

- The default token limit is 32,000 provider-reported tokens. It is persisted and overridable per run; it is not inferred from rendered text or context estimates.
- A request that reports usage can trigger token exhaustion. If any later request omits usage, final `used.tokens` and `remaining.tokens` intentionally become `null`, while `reportedTokens`, request counts, the exhausting record, and `tokens_exhausted` remain auditable.
- A wall timeout that aborts in-flight transport cannot honestly synthesize; it retains `wall_exhausted` in the ledger but terminates through TASK-004's legal `failed/none` path. Wall exhaustion observed between complete steps gets the normal bounded synthesis opportunity.
- TASK-008 still owns budget-extension UX/consumption. TASK-005 preserves the existing `budget-added` event name and backward-compatible `added` field for that work.

## Acceptance

Supervisor technical acceptance: PASS. The card remains `in_progress` until its PR is merged.
