# TASK-021 execution log

- Branch: `task/TASK-021-preflight-heartbeat`
- Started: `2026-07-29T17:58:51+08:00`
- Status: `in_progress`
- Verdict baseline: `a57e880`
- TASK-019 dependency: `5d4b467`
- Execution: direct Codex persistent goal
  `019fad4a-3615-7270-9281-004dd4ddc5a6` (no WenzMark task was supplied or
  available in this session)
- Worktree: `/private/tmp/papertable-task021`

## Checkpoints

- `2026-07-29T17:58:51+08:00` — Read `CONTEXT.md`, `CURRENT.md`, `PROJECT.md`,
  `AGENTS.md`, TASK-021, TASK-019, the TASK-019 timing contract/baseline/log,
  and the TASK-019/TASK-021 orchestration entries.
- `2026-07-29T17:58:51+08:00` — Preserved the dirty primary worktree and
  created an isolated TASK-021 worktree. Stacked committed/pushed TASK-019
  (`5d4b467`) on the verdict baseline (`a57e880`). The expected conflicts in
  `src/store.tsx`, `src-tauri/src/db.rs`, and `src/lib/formats.test.ts` were
  resolved by retaining both verdict-audit and performance-round-trip fields.
- `2026-07-29T18:00:41+08:00` — The first TypeScript dependency-layer check
  did not start: `pnpm exec` detected that `node_modules` was symlinked from
  the TASK-019 worktree and refused its non-TTY purge. No source assertion ran
  or failed. Adjusted verification to invoke the already-installed `tsc` and
  `tsx` binaries directly; the Rust focused build continued independently.
- `2026-07-29T18:06:45+08:00` — Completed the TASK-019 baseline and direct
  source read, including the relevant `src/store.tsx`, `src/lib/agent.ts`,
  `src-tauri/src/llm.rs`, Store persistence tests, and CardStage status path.
  Recorded current/target Promise graphs and the three ordering barriers in
  `outputs/task-021/preflight-promise-graph.md`.
- `2026-07-29T18:06:45+08:00` — Dependency merge verification passed:
  TypeScript typecheck, 34 focused TypeScript tests, and the focused Rust
  verdict/performance round-trip test.
- `2026-07-29T18:13:08+08:00` — The first progress/heartbeat focused run
  passed all 5 new/existing tests. Typecheck found one stale test-only
  annotation that collected `onPhase` values as strings; production sources
  had no type error. Updated that collector to the five-field `AgentProgress`
  contract before continuing.
- `2026-07-29T18:16:11+08:00` — Focused progress run passed 34/35. The new
  fixture's third empty `stop` response correctly entered the existing
  empty-provider retry path, so it obtained final text in the same exploration
  round and never reached the separate synthesis phase. Aggregate progress was
  already correct (1 search, 2 hits, 1 read). Changed only the fixture to a
  deterministic `length` transition into synthesis and replaced unsupported
  test-only `Array.at` calls with compatible indexing.
- `2026-07-29T18:17:42+08:00` — The rerun remained 34/35 because the fixture
  legally completed with final prose in its exploration request; that path
  must not claim a separate `answering` phase. Kept the retrieval case focused
  on aggregate counts/privacy and moved the `answering` assertion to the
  existing forced final-synthesis case. Production code was unchanged.
- `2026-07-29T18:18:36+08:00` — Immediate visibility gate passed 1/1. The E2E
  held verdict context for 350 ms, observed the new AI Turn/status within the
  100 ms contract, and proved no model stream request crossed the unresolved
  verdict barrier.
- `2026-07-29T18:19:45+08:00` — Verdict, project-library binding, attachment,
  and resume-only audit reads now start in the same JavaScript turn. The first
  barrier includes audited-Turn persistence; the dependent library metadata
  and Desktop live-scope reads then run together.
- `2026-07-29T18:19:45+08:00` — Moved the final
  `agentAudit.hostScope` assignment before capability admission/probing.
  Focused concurrency, verdict-freeze, and continuation tests passed 15/15
  with typecheck. A rejected scope read is proven to stop before Agent audit
  or model work.
- `2026-07-29T18:20:21+08:00` — `onPhase` now emits exactly `phase`, `round`,
  `searchCount`, `hitCount`, and `readCount`. It reports search start, returned
  hits, completed reads, and synthesis without exposing query/tool/source
  content. Focused progress/Agent tests passed 35/35.
- `2026-07-29T18:20:21+08:00` — Desktop renders one live status throughout a
  streaming Turn and refreshes elapsed seconds from the Turn start every
  1,000 ms. The pure projection privacy test and Desktop Vite production build
  passed.
- `2026-07-29T18:21:20+08:00` — Removed only the pretty-print arguments from
  `finalEvidence`. The real synthesis-request test parses the compact payload,
  compares it with the pretty form field-for-field, checks the canonical byte
  string, and retains frozen repair replay. Representative size is 551 to 426
  bytes and repository-estimated tokens are 276 to 203; see
  `outputs/task-021/final-evidence-size.json`.
- `2026-07-29T18:24:50+08:00` — The five-question runner stopped before
  launching a browser because its TASK-019 fixture URL traversed one directory
  too far. Corrected the evidence-only relative URL to the sibling
  `outputs/task-019/` directory; no product path or question execution had
  started.
- `2026-07-29T18:25:38+08:00` — The runner reached q1, where the new card's
  default sources-only mode correctly refused without a bound source and
  therefore had no model-dispatch timing. Updated only the evidence runner to
  explicitly select general mode for the healthy-provider timing scenario;
  the product's fail-closed behavior remains unchanged.
- `2026-07-29T18:26:41+08:00` — q1 still produced no model timing and the
  local service saw no request. The evidence runner clicked the mode control
  but did not wait for the Store label to flip. Added an explicit
  `回答依据：通用探索` visibility gate before sending; no product source changed.
- `2026-07-29T18:28:20+08:00` — Even after the mode label flipped, the
  evidence-only ordinary-chat scenario still produced no dispatch timing.
  Stopped iterating on that weaker scenario. The runner now creates and binds a
  real read-only library through the existing UI, so q1-q5 exercise native
  search/read/final, host scope, citation, and audit paths. Product code remains
  unchanged.
- `2026-07-29T18:29:32+08:00` — Library creation/binding succeeded, then the
  runner spent 30 seconds waiting on an unnecessary exact answer-mode label.
  A bound library enters Harness in either user-selectable mode. Removed only
  that evidence-runner assertion and kept the real library path.
- `2026-07-29T18:30:30+08:00` — Importing the library in a newly created
  project succeeded, but q1 still ended locally and had no `preflightMs`.
  That runner path did not establish the same effective project binding as
  the accepted E2E fixture. Aligned the evidence runner with
  `importReadOnlyFixture`: import and bind directly in the seeded project,
  without the extra new-project transition. Product code remains unchanged.
- `2026-07-29T18:34:39+08:00` — The seeded-project variant also produced a
  host-terminal performance object with no model dispatch for q1; the 500 ms
  fake service received no request. Stopped inferring state inside this
  standalone browser/IndexedDB runner. The q1-q5 performance rerun will use
  TASK-019's accepted `runAgentTurn` plus synthetic read-only evidence host
  against the same delayed fake provider, with TASK-021's concurrent
  preflight barrier included in the clock. Real UI behavior remains covered
  by the 100 ms browser gate and full Playwright suite.
- `2026-07-29T18:36:28+08:00` — The corrected q1-q5 rerun completed against
  the local provider with the same 500 ms delay. Every case used three model
  requests and two native host tool calls, completed normally, persisted the
  verdict Turn and froze scope before model dispatch, and started independent
  host reads in the same millisecond. `preflightMs` was 93–95 ms with a 94 ms
  median, below the 300 ms gate. Raw rows are in
  `outputs/task-021/post-implementation-preflight.json`. The real read-only UI
  path also passed its dedicated 500 ms Playwright scenario 1/1.
- `2026-07-29T18:37:47+08:00` — Final focused verification passed 83/83 plus
  typecheck. Coverage includes preflight concurrency/fail-close, Agent
  progress and continuation, verdict freezing, Desktop privacy projection,
  performance-field whitelisting, Web persistence, and package export. Started
  the full `pnpm verify` gate.
- `2026-07-29T18:38:13+08:00` — The first full verify stopped before tests:
  ESLint correctly reported that evidence-runner `scopeFrozenAt` was assigned
  only once and should be `const`. No production source or assertion failed.
  Scoped the timestamp as a local constant and restarted `pnpm verify` from
  typecheck.
- `2026-07-29T18:39:03+08:00` — Full `pnpm verify` passed from the beginning:
  typecheck, ESLint, Prettier, 266/266 Node/TypeScript/server tests, 97 passed
  Rust tests with one explicitly ignored live-MemOS integration, and the Web
  production build. Proceeding to full Playwright, Desktop build, strict Rust
  formatting/lints, and final diff review.
- `2026-07-29T18:41:08+08:00` — The first full Playwright run passed 41/42.
  The multi-tab project-cascade test found one orphan streaming AI Turn after
  deletion. That row carried TASK-021's initial progress fields, so it cannot
  be dismissed as unrelated flakiness without evidence. Repeating the focused
  scenario and reviewing the race between cross-tab cascade deletion and
  asynchronous Turn persistence before choosing the smallest correction.
- `2026-07-29T18:42:30+08:00` — The failed multi-tab scenario passed 3/3
  parallel repeats. Direct review of `delta.ts` confirms that the existing
  cross-tab upsert contract explicitly tolerates a non-destructive stale-tab
  resurrection window; the first full run's fixed 700 ms wait reached that
  documented window under suite load. TASK-021 does not change deletion
  semantics, so no out-of-scope storage redesign was added. Restarting all 42
  browser scenarios and requiring a completely green run.
- `2026-07-29T18:43:54+08:00` — The second complete Playwright run passed
  42/42 in 59.1 seconds. The suite covers the new 100 ms visibility/verdict
  gate plus existing native search/read/citation, continuation, fail-close,
  multi-tab, and hidden-reasoning paths. Proceeding to final Desktop, strict
  Rust, diff, and evidence checks.
- `2026-07-29T18:45:59+08:00` — Desktop production build, Rust formatting,
  and strict Clippy passed. Final diff review found that cold-start and
  event-audit recovery cleared legacy `agentPhase` but not the new
  `agentProgress`. Although the object is content-free, retaining stale
  counters on a non-streaming Turn violates its lifecycle contract. Added the
  matching cleanup and assertions in both recovery paths; affected and full
  gates must be rerun.
- `2026-07-29T18:46:39+08:00` — The recovery lifecycle correction passed
  45/45 focused context, resume, and IndexedDB tests plus typecheck. Restarting
  final `pnpm verify` from the beginning, followed by browser recovery/resume
  coverage.
- `2026-07-29T18:47:31+08:00` — Final `pnpm verify` after the lifecycle fix
  passed again from the beginning: 266/266 Node/TypeScript/server tests, 97
  passed Rust tests plus one expected ignored live-MemOS integration,
  typecheck, lint, formatting, and Web production build. Running focused
  browser cold-recovery/stop-reload/same-run continuation checks and rebuilding
  Desktop.
- `2026-07-29T18:49:21+08:00` — Final browser recovery/continuation coverage
  passed 3/3 and Desktop rebuilt successfully. Formatting, diff whitespace,
  q1-q5 performance JSON, compact-payload JSON, sensitive-data scan, and
  artifact inventory checks passed. Restored all screenshots rewritten by
  existing E2E cases; the worktree contains only TASK-021 source, tests, card,
  log, and output artifacts.

## Candidate result

- All eight TASK-021 checklist items are complete.
- Executor status remains `in_progress`; only the independent supervisor may
  accept, commit, push, merge, and mark `done`.

## Verification

- See `outputs/task-021/verification.md`.
