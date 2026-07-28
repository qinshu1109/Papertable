# TASK-003 execution log

- Branch: `task/TASK-003-event-schema`
- Started: `2026-07-28T10:54:17+08:00`
- Status: `in_progress`
- WenzMark task ID: `67c028a4-8c68-4afe-b668-91ff2f5f26fd`

## Checkpoints

- `2026-07-28T10:54:17+08:00` — Confirmed the requested branch and preserved the pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/` files.
- `2026-07-28T10:54:17+08:00` — Read the required workspace context, TASK-003 card, accepted ADR-006, and TASK-002 dependency evidence in the prescribed order.
- `2026-07-28T11:06:50+08:00` — Added SQLite schema v8 and Dexie schema v6, versioned `AgentMessage`/working-set boundary types, insert-only event APIs, legacy audit reads, and deterministic transaction crash/reopen coverage.
- `2026-07-28T11:06:50+08:00` — Completed repository gates, workspace validation, migration checks, formatting, and scope audit. The card remains `in_progress` for supervisor acceptance.

## Tests

- `pnpm exec tsx --test src/lib/agentEvents.test.ts src/lib/storage/dexie.test.ts` — PASS, 20/20 tests.
- `cargo test --manifest-path src-tauri/Cargo.toml db::tests -- --nocapture` — environment lookup returned `command not found: cargo` (exit 127); no test ran.
- `/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml db::tests -- --nocapture` — PASS, 20/20 targeted database tests plus 0 binary test failures.
- `pnpm typecheck` — PASS.
- `pnpm exec eslint src/lib/agentEvents.ts src/lib/agentEvents.test.ts src/lib/storage/types.ts src/lib/storage/tauri.ts src/lib/storage/index.ts src/lib/storage/dexie.ts src/lib/storage/dexie.test.ts` — PASS.
- `pnpm exec prettier --check ...` and `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — initially identified mechanical formatting in three TypeScript files and one Rust line.
- `pnpm exec prettier --write src/lib/agentEvents.test.ts src/lib/storage/dexie.ts src/lib/storage/dexie.test.ts` and `/Users/qinshu/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml` — PASS.
- `pnpm verify` — PASS end to end: typecheck, repository lint, repository format check, 132/132 JS/TS/server tests, 80/80 Rust tests, and production build. Vite emitted only the existing chunk-size advisory.
- `/Users/qinshu/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — PASS after formatting.
- `pnpm exec prettier --check src/lib/agentEvents.ts src/lib/agentEvents.test.ts src/lib/storage/types.ts src/lib/storage/tauri.ts src/lib/storage/index.ts src/lib/storage/dexie.ts src/lib/storage/dexie.test.ts harness-rebuild/tasks/TASK-003.md harness-rebuild/logs/TASK-003.md` — PASS.
- `python3 /Users/qinshu/.codex/skills/init-ai-project-workspace/scripts/workspace_builder.py validate --root /Users/qinshu/Documents/Codex/2026-07-25/https-b23-tv-cq1kdqg/papertable/harness-rebuild` — PASS (`ok: true`, no errors); reminders only request confirmation records for accepted ADR-001–007, whose files already cite the user confirmation source.
- `git diff --check` — PASS.
- `git diff --exit-code -- src/lib/agent.ts src/store.tsx src/lib/context.ts src/lib/provider/http.ts src/lib/provider/tauri.ts src-tauri/src/llm.rs` — PASS; no runtime-loop, context, provider, or LLM wiring changed.
- `rg -n "appendAgentStep|loadAgentAudit" src/lib/agent.ts src/store.tsx src-tauri/src/llm.rs` — no matches.

## Verify matrix

| Contract                     | Evidence                                                                                                                                 | Result |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Versioned schema             | SQLite `user_version=8`; Dexie v6; both `agent_runs` and `agent_events` carry `schema_version`                                           | PASS   |
| Complete step vocabulary     | 11 TASK-003 event kinds; explicit test rejects token deltas as persisted steps                                                           | PASS   |
| Append-only events           | SQLite insert-only API + `agent_events_no_update` trigger; Dexie API uses `add`, never `put`                                             | PASS   |
| Transactional state change   | Event insert and `agent_runs` checkpoint/sequence update share one SQLite/Dexie transaction                                              | PASS   |
| Deterministic crash recovery | All 11 event kinds tested at 3 internal failure points (33 rollback/reopen cases) plus reopen after each of 11 committed step boundaries | PASS   |
| No partial row               | Reopen always exposes the prior event count/sequence/checkpoint; injected event id is absent                                             | PASS   |
| Legacy compatibility         | Real v7 SQLite and v4 Dexie upgrades retain old turns and return `kind: legacy`; run/event counts remain zero                            | PASS   |
| Full audit vs working set    | `AgentMessage` keeps structured audit/source text; `AgentWorkingSet` and `ConvertToLlm` are separate, unwired types                      | PASS   |
| Audit retention              | Ordinary SQLite/Dexie workspace snapshot replacement preserves event-sourced audit rows                                                  | PASS   |
| No later-card runtime wiring | Runtime/context/provider/LLM diff and reference audits are empty                                                                         | PASS   |

## Migration and recovery evidence

- SQLite migration replays the idempotent schema at version 8 and creates `agent_runs`, `agent_events`, the `(run_id, sequence)` index, uniqueness constraints, and the no-update trigger.
- Dexie v6 adds matching run/event stores without modifying existing turn records.
- The v7 SQLite fixture is closed and reopened after migration; its legacy trace remains readable and no run/event rows are synthesized.
- The crash matrix uses a real temporary on-disk SQLite database in WAL mode. Each injected failure drops the connection without cleanup, reopens through production `open()`/`migrate()`, and reads only the last committed checkpoint.

## Scope audit

- Changed only TASK-003 governance/log files, versioned Agent event types/tests, storage adapters/tests, SQLite schema/database code, and the two new Tauri commands.
- `src/lib/agent.ts`, `src/store.tsx`, `src/lib/context.ts`, provider transports, and `src-tauri/src/llm.rs` are unchanged.
- No runtime-loop event emission, resume orchestration, UI rendering, budget logic, retry logic, or protocol-repair behavior was wired.
- Preserved the pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/`.
- No files were staged or committed; branch remains `task/TASK-003-event-schema`.

## Unresolved risks

- Runtime emission, working-set projection, and actual resume orchestration intentionally remain for later cards; TASK-003 only provides their persistence and type boundary.

## Acceptance

- `2026-07-28T11:10:04+08:00` — Supervisor independently reviewed the event vocabulary, SQLite transaction and migration path, Dexie parity, crash/reopen tests, and unchanged runtime scope.
- `2026-07-28T11:10:04+08:00` — Supervisor independently reran `pnpm verify`, Rust formatting, workspace validation, and `git diff --check`; all required gates passed.
- Technical acceptance: **PASS**. Ready for scoped commit, PR, CI, and merge.
