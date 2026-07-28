# TASK-008 execution log

- Branch: `task/TASK-008-resume-run`
- Started: `2026-07-28T13:10:37+08:00`
- Status: `done`
- WenzMark task ID: `073a5c3b-b571-409e-bf04-aee2bbc23022`

## Checkpoints

- `2026-07-28T13:10:37+08:00` — Confirmed the requested branch at the TASK-007 integration baseline; preserved the pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/`.
- `2026-07-28T13:10:37+08:00` — Read the required workspace context, TASK-003 through TASK-007 cards/logs/outputs, accepted ADR-002 through ADR-007, and cited Papertable research sections directly in the requested order.
- `2026-07-28T13:21:00+08:00` — Added schema-v1 same-run continuation claims, optimistic cursor enforcement, TASK-005 ledger extension, exact ADR-006 working-set reconstruction, completed-tool deduplication, and legal resumability checks.
- `2026-07-28T13:27:00+08:00` — Generalized interrupted-turn reconciliation: streaming turns are rebuilt from authoritative run events, settled at an auditable `interrupted` checkpoint, and retain partial visible trace/content.
- `2026-07-28T13:31:00+08:00` — Added frozen-scope parity in Rust search, browser/Rust atomicity and reopen tests, and crash-after-budget recovery without double charging.
- `2026-07-28T13:34:00+08:00` — Added the visible `继续深挖` same-turn UI and a reload-persistent Playwright scenario proving the seven-category provider working set and same run/turn identity.
- `2026-07-28T13:38:24+08:00` — Completed full verification, fixture validation, workspace validation, and scope audit; left this task `in_progress` for supervisor acceptance.
- `2026-07-28T13:49:00+08:00` — Supervisor review found and fixed the crash window where the budget claim was durable but the streaming UI row was not yet durable. Cold-start reconciliation now settles that non-terminal audit before exposing the old partial turn, without changing explicit user-stopped turns.
- `2026-07-28T13:52:00+08:00` — Supervisor reran focused continuation/crash/scope tests, `pnpm verify`, strict Rust gates, and the complete Playwright suite. All gates passed; WenzMark was independently confirmed `awaitingAcceptance` with exit code 0.

## Tests

- `pnpm exec tsx --test src/lib/agentResume.test.ts src/lib/agentBudget.test.ts src/lib/agentBudgetAudit.test.ts src/lib/storage/dexie.test.ts src/lib/context.test.ts` — PASS, 49/49.
- `pnpm exec playwright test e2e/papertable.spec.ts --grep "继续深挖 adds budget" --reporter=line` — PASS, 1/1.
- `/Users/qinshu/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — PASS.
- `/Users/qinshu/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings` — PASS.
- `/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --lib` — PASS, 87/87.
- `pnpm verify` — PASS: typecheck, ESLint, Prettier check, 212/212 TypeScript/server tests, 87/87 Rust tests, and production build. Vite emitted only its pre-existing advisory that the main bundle exceeds 500 kB.
- `pnpm test:e2e -- --reporter=line` — PASS, 30/30.
- Supervisor post-fix `pnpm verify` — PASS: 213/213 TypeScript/server tests, 87/87 Rust tests, build and static gates.
- Supervisor post-fix `pnpm test:e2e -- --reporter=line` — PASS, 30/30 after one deterministic regression fix for preserving explicit `stopped` status.
- Ruby workspace/frontmatter validation — PASS, schema-v2 workspace and all 13 task cards; TASK-008 remains `in_progress` with the requested WenzMark ID.
- `jq` fixture validation — PASS, four schema-v1 JSON fixtures; working-set fixture has exactly seven ordered categories.

## Verification iterations

- The first targeted Playwright run exposed the native protocol guard as a separate leading system message; the assertion was corrected to inspect the immediately following seven-message ADR-006 working-set window. The rerun and full suite passed.
- The first strict Clippy run found the refactored test-only `search_project` helper unused in production plus three needless borrows. The helper was gated with `cfg(test)`, the borrows were removed, and strict Clippy passed.
- The first `pnpm verify` stopped at Prettier for three TASK-008 files. They were formatted, then the complete verify command passed.
- Bare `cargo` is not on this shell's `PATH`; all successful direct Rust gates used the installed `/Users/qinshu/.cargo/bin/cargo`. The package `test:rust` fallback also found that executable.

## Scope audit

- Product changes are limited to Agent run/event/checkpoint persistence, TASK-005 budget continuation, provider working-set reconstruction, current-run tool deduplication, interrupted recovery, frozen Rust note scope, the `继续深挖` UI, and directly related deterministic tests.
- Replay artifacts are isolated under `outputs/task-008/`: `same-run-event-flow.json`, `seven-category-working-set.json`, `crash-reopen.json`, `double-resume.json`, and `README.md`.
- No project/library widening, deletion path, provider switching, attachment work, export behavior, or unrelated task card was changed.
- `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, `qa-evidence/`, and all unrelated user files remain unmodified and untracked.
- No files were staged or committed; branch remains `task/TASK-008-resume-run`.

## Unresolved risks

- Pre-TASK-005/pre-host-scope legacy audit rows are deliberately rejected for continuation because their ledger or frozen authority cannot be reconstructed safely.
- The UI currently applies the fixed, audited continuation increment (4 rounds, 8 calls, 120 seconds, 32,000 tokens); TASK-008 does not introduce a user-editable budget picker.
- Crash equivalence is defined at fully committed host steps. A provider request interrupted outside a committed tool result may be requested again, but partial tool batches are never executed/replayed and completed tools remain deduplicated.

## Acceptance

Supervisor technical acceptance: PASS. PR #10 passed CI and was squash-merged into `feat/readonly-note-harness-alpha` as `dcdaba6`; WenzMark was closed as `completed`.
