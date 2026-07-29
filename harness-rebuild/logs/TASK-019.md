# TASK-019 execution log

- Branch: `task/TASK-019-performance-baseline`
- Started: `2026-07-29T17:23:24+08:00`
- Status: `in_progress`
- Base HEAD: `41c915e`
- Execution: direct Codex persistent goal
  `019fad2d-eed2-7b63-88de-68b713539690` (no WenzMark task was supplied or
  available in this session)
- Worktree: `/tmp/papertable-task019`

## Checkpoints

- `2026-07-29T17:23:24+08:00` — Read `CONTEXT.md`, `CURRENT.md`,
  `PROJECT.md`, TASK-019, `AGENTS.md`, and the TASK-019 orchestration entries.
  The card has no dependencies or referenced ADRs and is unlocked.
- `2026-07-29T17:23:24+08:00` — A direct branch switch was safely rejected
  because the primary worktree contains pre-existing edits to
  `ORCHESTRATION.md` and `tasks/README.md`. Preserved them untouched and
  created an isolated worktree/branch from accepted base `41c915e`.
- `2026-07-29T17:29:00+08:00` — Froze five realistic Chinese questions,
  serial execution, Apple M4 / 16 GiB / Darwin 25.5.0, Node 24.18.0, pnpm
  11.17.0, accepted base `41c915e`, and model `claude-opus-5`. No API key,
  provider URL, absolute note path, or note body is present in the environment
  or performance record.
- `2026-07-29T17:31:00+08:00` — Defined send, local first-provider-dispatch,
  first answer-gate-visible/explicit-terminal, and terminal Store commit
  boundaries in `outputs/task-019/timing-contract.md`.
- `2026-07-29T17:36:00+08:00` — Before production implementation changes,
  ran q1-q5 serially through the real provider and native search/read protocol
  using the safe TASK-013 synthetic evidence host. All five completed. Raw
  rows and medians (`1 / 36516 / 36516 ms`) are in
  `outputs/task-019/pre-implementation-baseline.json`.
- `2026-07-29T17:37:00+08:00` — Focused TypeScript/Node suite passed 76/77.
  The only failure was in the new fake-delay assertion: `sseEvent` returns
  bytes and the test joined them as decimal numbers instead of decoding SSE
  text. The injected 250 ms sleep and event writes both ran; production code
  and timing semantics were unchanged. Fix: decode chunks with `TextDecoder`
  and rerun before checking any implementation item.
- `2026-07-29T17:38:00+08:00` — After decoding SSE bytes, the focused
  Node/TypeScript suite passed 77/77. The chained Rust command then returned
  127 because `cargo` is absent from this shell PATH. The repository's own
  `test:rust` script documents the fixed-toolchain fallback; rerun with
  `/Users/qinshu/.cargo/bin/cargo` before acceptance.
- `2026-07-29T17:39:00+08:00` — Added the optional numeric-only
  `AgentRunTrace.performance` record at the shared Store/Agent boundary. The
  first dispatch hook covers capability probes plus streaming/non-streaming
  Agent requests; first-visible is marked at answer-gate UI commit or explicit
  terminal; total is marked before the terminal Store update.
- `2026-07-29T17:39:00+08:00` — Web Dexie, Desktop SQLite, and native lossless
  project package round trips preserve the timing object. Rust focused test
  passed through the fixed cargo path; TypeScript typecheck passed.
- `2026-07-29T17:39:00+08:00` — Added bounded test-only fake-provider delay
  control (`PAPERTABLE_FAKE_LLM_DELAY_MS`, default zero) for both stream and
  non-stream responses. The deterministic test injects a fake sleeper, so the
  suite remains fast and the default E2E timing is unchanged.
- `2026-07-29T17:39:00+08:00` — Numeric whitelist tests prove the performance
  record cannot retain prompts, tool arguments, API keys, absolute paths, or
  note bodies; host terminals without a provider request omit only
  `preflightMs`.
- `2026-07-29T17:41:00+08:00` — First `pnpm verify` stopped at ESLint because
  the evidence-only baseline runner named an unused `_event` callback
  parameter. No production or test assertion failed. Removed the unused
  parameter/type import and restarted the full gate from typecheck.
- `2026-07-29T17:43:00+08:00` — Full `pnpm verify` passed: typecheck, ESLint,
  Prettier, 232 Node/TypeScript/server tests, 94 Rust tests, and production Web
  build. Default Playwright passed 36/36; a dedicated read-only Harness run
  with `PAPERTABLE_FAKE_LLM_DELAY_MS=500` passed 1/1.
- `2026-07-29T17:43:00+08:00` — Desktop build, Rust formatting, strict Clippy,
  and `git diff --check` passed. Playwright-modified screenshots belonging to
  TASK-009/010/012 were restored to HEAD; no other task output or primary
  worktree modification was touched.

## Candidate result

- All TASK-019 checklist items are complete and evidenced under
  `outputs/task-019/`.
- Executor status remains `in_progress`; only the independent supervisor may
  accept, commit, push, merge, and mark `done`.

## Verification

- See `outputs/task-019/verification.md`.
