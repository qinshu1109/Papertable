# TASK-011 execution log

- Branch: `task/TASK-011-delete-legacy-fallbacks`
- Started: `2026-07-28T15:20:43+08:00`
- Status: `in_progress`
- WenzMark task ID: `47c07b2c-6332-40a8-8e9e-004d6eeec6bb`

## Checkpoints

- `2026-07-28T15:20:43+08:00` — Confirmed the requested branch at `9e527e1`; preserved the pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/`.
- `2026-07-28T15:20:43+08:00` — Began the required direct ordered read of workspace context, TASK-004 through TASK-010 cards/logs/outputs, accepted ADR-001/002/004/006/007, cited research, and the complete production/test legacy surface.
- `2026-07-28T15:24:00+08:00` — Completed the ordered read and exhaustive symbol inventory. Captured the source and bundle baseline before deletion.
- `2026-07-28T15:27:00+08:00` — Physically deleted the planner, two-stage workflow, H host-search helper, executable A-Q matrix, and their dedicated legacy test file. Updated native-only architecture copy and objective failure-path tests.
- `2026-07-28T15:34:06+08:00` — Completed all full gates, restored only three TASK-009/010 screenshots rewritten by Playwright, and began the final scope audit.

## Tests

- Initial pre-fixture focused suite:
  `pnpm exec tsx --test src/lib/agent.test.ts src/lib/agentProtocolPipeline.test.ts src/lib/provider/capabilityGate.test.ts src/lib/provider/http.test.ts`
  — 48/48 passed.
- First run after adding schema-v1 evidence — 48/49 passed. The new fixture
  assertion incorrectly compared a two-key expected object with the complete
  four-key historical descriptor. The assertion was corrected without
  changing runtime behavior or evidence.
- Final focused suite — 49/49 passed.
- `pnpm verify` — passed:
  - `tsc -b`
  - `eslint .`
  - `prettier --check .`
  - TypeScript/server tests: 211 passed, 0 failed
  - Rust tests: 88 passed, 0 failed
  - Vite production build: 2,001 modules transformed, passed
- Strict Rust gates — passed:
  - `/Users/qinshu/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
  - `/Users/qinshu/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
  - `/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml`
    — 88 passed, 0 failed
- Full Playwright:
  `pnpm test:e2e -- --reporter=line` — 35 passed, 0 failed.
- Workspace validator — `ok: true`, zero errors. It emitted only the existing
  reminders to check confirmation records for accepted ADR-001 through
  ADR-007.
- Fixture validation — every evidence JSON under `harness-rebuild/outputs/`
  outside dependency `node_modules` passed `jq empty`. An initial unscoped
  scan found JSONC/tsconfig files inside the historical TASK-001
  `node_modules`; those are dependency sources, not evidence fixtures, and
  were excluded rather than edited.
- `pnpm format:check` — passed.
- `git diff --check` — passed.

## Deleted-symbol inventory

- `runTwoStage`
- `planQueries`
- `queriesFromPlanner`
- `searchAndRead`
- `latestQuestion`
- `isInventoryQuestion`
- `citationContext`
- `searchMetadataContext`
- `retrievalFailureInstruction`
- exported `LEGACY_EXIT_TERMINAL_MATRIX`
- `src/lib/agentStateMachine.test.ts`
- obsolete H-path test scaffolding, fallback labels, comments, and
  architecture copy

## Before/after evidence

- Production: 76 files / 33,117 lines before; 76 files / 32,795 lines after
  (`-322` lines).
- Tests: 29 files / 10,149 lines before; 28 files / 10,229 lines after
  (`-1` file, `+80` lines due to objective no-fallback coverage).
- `src/lib/agent.ts`: 2,130 to 1,809 lines (`-321`).
- `src/lib/agent.test.ts`: 1,117 to 1,212 lines (`+95`).
- `src/lib/agentProtocolPipeline.test.ts`: 546 to 574 lines (`+28`).
- Deleted legacy matrix test: 43 to 0 lines.
- Baseline main asset: 784,590 bytes / 755.93 kB / 256.47 kB gzip.
- Final main asset: 784,085 bytes / 755.43 kB / 256.45 kB gzip.
- Other measured assets and total `dist` allocation were unchanged; total
  remained 860 KB. The 505-byte main-asset delta is below noise and is not
  claimed as a meaningful size win.
- Complete evidence:
  `harness-rebuild/outputs/task-011/deletion-report.md` and
  `harness-rebuild/outputs/task-011/no-fallback-replay.json`.

## Scope audit

- Branch remains `task/TASK-011-delete-legacy-fallbacks` at uncommitted base
  `9e527e1`; no branch switch, commit, push, PR, or merge occurred.
- TASK-011 status remains `in_progress`.
- The index is empty; no file was staged.
- The requested user-owned untracked `QA_REPORT.md`,
  `conversation-2026-07-27-084611.txt`, and `qa-evidence/` remain untouched.
- Full Playwright regenerated three tracked dependency-card screenshots.
  They were restored exactly, leaving no TASK-009/010 screenshot diff.
- Executable production/test definitions and calls for `runTwoStage`,
  `planQueries`, all deleted helpers, the A-Q matrix, and host-fallback labels
  are zero.
- Retained `two-stage`, `streamingToolCalls`, and `toolResultAccepted` strings
  are restricted to serialized persistence/migration fixtures proving legacy
  readability or invalidation. Prior ADR/research/task/log/output occurrences
  are inert audit history. The protected untracked QA export is also inert and
  untouched.

## Findings

- No card-external implementation issue was found.
- The existing Vite warning for the greater-than-500 kB main chunk remains;
  TASK-011 does not expand into code splitting.
- The accepted native state machine, same-run continuation, controlled
  citations, frozen host scope, four-dimensional budgets, no-progress
  handling, protocol retry/repair, and three-stage admission stayed green in
  full regression.
- Ordinary no-library chat and deterministic sources-only local refusal have
  explicit focused coverage and passed.

## Supervisor acceptance

- WenzMark run `47c07b2c-6332-40a8-8e9e-004d6eeec6bb` reached
  `awaitingAcceptance` with exit code `0`.
- The supervisor independently reviewed the complete diff and repeated the
  deleted-symbol audit; no production definition or call remains.
- Independent `pnpm verify` passed: 211 TypeScript/Node tests, 88 Rust tests,
  and the production build.
- Independent full Playwright regression passed: 35/35.
- Regenerated TASK-009/010 screenshots were restored and excluded from this
  card. Protected untracked QA files remain untouched.
- Acceptance conclusion: pass. The change is eligible for explicit-path
  commit, PR, CI, and merge.
