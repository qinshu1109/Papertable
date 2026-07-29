# TASK-019 verification

Candidate status: `in_progress` / awaiting supervisor acceptance.

## Baseline

- Real provider/model: configured OpenAI-compatible provider /
  `claude-opus-5`.
- Frozen cases: `frozen-questions.json` q1-q5, serial, warm capability cache.
- Median `preflightMs / firstVisibleMs / totalMs`:
  `1 / 36516 / 36516`.
- Raw rows: `pre-implementation-baseline.json`.

## Passing gates

- Focused Node/TypeScript: 77/77.
- Focused Desktop SQLite round trip: 1/1.
- `pnpm verify`: 232 Node/TypeScript/server tests, 94 Rust tests,
  typecheck, ESLint, Prettier, and production Web build passed.
- `pnpm test:e2e`: 36/36 passed with default fake-provider timing.
- `PAPERTABLE_FAKE_LLM_DELAY_MS=500 pnpm exec playwright test -g
"a read-only library uses bounded tools"`: 1/1 passed.
- `pnpm build:desktop`: passed.
- `cargo fmt --check`: passed.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `git diff --check`: passed.

## Recorded and resolved failures

1. Direct branch switching was blocked by pre-existing primary-worktree edits;
   an isolated worktree/branch from `41c915e` preserved them.
2. The first focused fake-delay assertion joined SSE bytes as decimal text;
   `TextDecoder` fixed the test and the rerun passed 77/77.
3. Direct `cargo` was absent from shell PATH; the repository's fixed cargo
   fallback passed.
4. The first full verify found one unused parameter in the evidence runner;
   it was removed and full verify passed from the beginning.

No Agent tool sequence, prompt, citation, verdict, timeout, concurrency,
streaming, or UI semantics were changed.
