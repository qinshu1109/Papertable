# TASK-021 verification

Candidate status: `in_progress` / awaiting supervisor acceptance.

## Acceptance measurements

- Frozen inputs: TASK-019 `frozen-questions.json`, q1–q5, serial.
- Provider: local `papertable-test-model`, warm capability cache, deterministic
  `PAPERTABLE_FAKE_LLM_DELAY_MS=500`.
- Healthy host fixture: 40 ms verdict/library/attachment reads, 20 ms audited
  Turn persistence, then parallel 30 ms library metadata/live-scope reads.
- `preflightMs`: 93–95 ms; median **94 ms**, below the 300 ms gate.
- Every case completed with three model requests and two native host tool
  calls. Independent first-layer reads started in the same millisecond, and
  both audited verdict persistence and scope freezing preceded model dispatch.
- Raw rows: `post-implementation-preflight.json`; repeatable runner:
  `preflight-runner.ts`.
- The 350 ms verdict-delay browser test observed the AI Turn and in-progress
  status within the 100 ms contract and proved that no model request crossed
  the unresolved verdict barrier.
- Compact `finalEvidence`: 551 to 426 bytes, saving 125 bytes (22.69%).
  Repository-estimated tokens: 276 to 203, saving 73. Parsed fields and nested
  values remain equivalent; see `final-evidence-size.json`.

## Passing gates

- Focused preflight/progress/verdict/resume/storage/export: 83/83 plus
  typecheck.
- Final recovery lifecycle focus: 45/45 plus typecheck.
- `pnpm verify`: typecheck, ESLint, Prettier, 266/266
  Node/TypeScript/server tests, 97 passed Rust tests plus one expected ignored
  live-MemOS integration, and Web production build.
- `pnpm test:e2e`: 42/42 passed in the final complete run.
- Post-lifecycle-fix browser recovery/continuation focus: 3/3.
- `PAPERTABLE_FAKE_LLM_DELAY_MS=500 pnpm exec playwright test -g
"a read-only library uses bounded tools"`: 1/1.
- `pnpm build:desktop`: passed after the final source change.
- `cargo fmt --check`: passed.
- `cargo clippy --all-targets --all-features -- -D warnings`: passed.
- `git diff --check`: passed.

## Recorded and resolved verification issues

1. The initial five-question standalone browser runner did not establish the
   same project/library binding as the accepted E2E fixture and therefore
   produced host-local q1 terminals. It was replaced with TASK-019's accepted
   `runAgentTurn` plus synthetic read-only evidence host while the real UI path
   remained covered separately.
2. The first `pnpm verify` stopped before tests on one evidence-runner
   `prefer-const` lint finding. The local variable was made constant and the
   full gate passed twice from the beginning.
3. The first complete Playwright run passed 41/42; its multi-tab cascade case
   reached the repository's documented stale-tab resurrection window under
   suite load. That case then passed 3/3, and the next full run passed 42/42.
   No out-of-scope deletion-protocol change was made.
4. Final review found stale safe progress counters could survive cold/audit
   recovery. Both recovery paths now clear `agentProgress`, with focused,
   full, browser, and Desktop reruns passing.

The performance records contain durations, counts, booleans, stable fixture
labels, and terminal enums only—no prompt text, query, tool arguments, keys,
absolute note paths, note bodies, model transcript, or hidden reasoning.
