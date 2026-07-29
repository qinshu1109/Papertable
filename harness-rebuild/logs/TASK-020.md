# TASK-020 execution log

- Branch: `task/TASK-020-desktop-async-http-reuse`
- Started: `2026-07-29T18:00:08+08:00`
- Status: `in_progress`
- Integrated base HEAD: `d3b8951` (`a57e880` verdict chain + TASK-019 code)
- Dependency: TASK-019 `done`, PR #19, merge `19b1c86`, acceptance `7136b97`
- Execution: direct Codex persistent goal
  `019fad49-c32b-7ef3-93df-6f8e023ff603` (no WenzMark task was supplied or
  available in this session)
- Worktree: `/private/tmp/papertable-task020`

## Checkpoints

- `2026-07-29T18:00:08+08:00` — Read `CONTEXT.md`, `CURRENT.md`,
  `PROJECT.md`, TASK-020, dependency TASK-019 and its outputs/log, plus
  `AGENTS.md`. Independently accepted TASK-019 after local and GitHub gates
  passed, then created this isolated branch/worktree without modifying the
  user's dirty primary worktree.
- `2026-07-29T18:01:13+08:00` — Initial Rust command inventory found a
  baseline mismatch: accepted base `7136b97` has no `src-tauri/src/memos.rs`
  and no `verdict_*` commands, while TASK-020 explicitly requires both.
  Commit `a57e880` contains the combined TASK-014～018 candidate and those
  paths. Stopped before production edits; resolving the correct integrated
  base is required to avoid silently dropping the verdict work.
- `2026-07-29T18:03:00+08:00` — Classified the mismatch using the existing
  parallel TASK-021 worktree: its immutable base commit `d3b8951` is exactly
  `a57e880` plus the independently accepted TASK-019 implementation and has
  no TASK-021 edits. Rebasing this card's startup-only commit onto `d3b8951`
  preserved both verdict and timing semantics without touching the live
  TASK-021 worktree or the user's primary worktree.
- `2026-07-29T18:05:39+08:00` — Completed the Rust/frontend call-chain audit.
  The 14-command inventory, frozen boundaries, connection/session ownership,
  and TASK-019 comparison fixture are in
  `outputs/task-020/blocking-command-inventory.md`. Pure short local commands
  remain synchronous by design.
- `2026-07-29T18:08:08+08:00` — Moved all four non-streaming LLM commands,
  five verdict commands, and the four generation-path note/attachment
  search/read commands to Tauri's blocking pool. The existing `llm_stream`
  path was retained. `cargo test` passed 97/97 with the pre-existing live
  MemOS test ignored; no frontend invoke shape, timeout, cancellation flag,
  scope argument, or Rust allowlist function changed.
- `2026-07-29T18:09:58+08:00` — Added process-wide standard-library
  `OnceLock<ureq::Agent>` pools for LLM and MemOS. Focused loopback tests pass:
  the LLM serves two requests through one accepted socket; MemOS serves two
  complete logical calls through one socket while observing fresh
  `session-a`/`session-b` initialize boundaries. Evidence:
  `outputs/task-020/connection-pool-verification.md`.
- `2026-07-29T18:45:49+08:00` — Built and operated the isolated
  `com.papertable.task020.qa` desktop bundle against the local five-second
  OpenAI-compatible fixture. During an explicit delayed connection request,
  the app switched cards and accepted a native window drag within the first
  2,554ms; the 50ms browser heartbeat recorded a 53ms maximum gap over 236
  samples through completion (250ms limit). The switched card remained
  visible. Submitted the exact TASK-019 q1-q5 set serially through the
  packaged desktop UI and read the completed Store values back from the
  isolated SQLite database. The median `preflight / firstVisible / total` was
  `26 / 5042 / 5042ms`. Evidence and the non-apples-to-apples provider caveat:
  `outputs/task-020/desktop-5s-responsiveness.md` and
  `post-implementation-5s.json`. The temporary heartbeat script was removed
  from source immediately after capture; the formal app was restored.
- `2026-07-29T18:48:46+08:00` — First final `pnpm verify` stopped at
  ESLint before tests because the reproducibility-only delayed-provider
  script referenced Node globals (`process`, `Buffer`, `setTimeout`) under
  the browser-oriented lint config. Replaced them with explicit
  `node:process`, `node:buffer`, and `node:timers/promises` imports. No
  dependency or production path changed; full verification is being rerun.
- `2026-07-29T18:49:41+08:00` — Second `pnpm verify` passed typecheck and
  ESLint, then stopped at Prettier because four task log/evidence files needed
  repository formatting. This is a mechanical artifact-only fix; production
  code still has no failing gate. Running the pinned formatter, then the
  complete verification sequence again.
- `2026-07-29T18:52:53+08:00` — Final gates are green: both focused pool
  tests passed; full Rust is 99 passed / 1 pre-existing opt-in live MemOS test
  ignored; strict clippy and fmt passed; `pnpm verify` passed with 262
  Node/TypeScript tests and the full Rust/build chain; Desktop E2E passed
  41/41 in 59.4s; `pnpm build:desktop`, fixture smoke, and
  `git diff --check` passed. The four E2E screenshot files overwritten by the
  test runner were mechanically restored to their exact pre-run bytes, so no
  unrelated artifact drift remains. Full command transcript:
  `outputs/task-020/verification.md`. Every task checkbox is complete; status
  remains `in_progress` because the executor may not self-mark `done`.
