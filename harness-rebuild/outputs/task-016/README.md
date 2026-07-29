# TASK-016 reroute tombstone evidence

- `entrypoints.json` maps every current reroute UI entry to the shared
  `createCard(type: "branch")` boundary without changing branch metadata.
- `cutoff-cases.json` records the deterministic complete-round extraction
  cases covered by `src/lib/verdicts/reroute.test.ts`.
- `gate-failures.json` records the transient proposal, persistence, retry,
  skip, and no-write invariants. The write-failure/retry/first-injection path is
  exercised by the Playwright test named
  `reroute persists first, waits for confirmation, then injects the confirmed tombstone`.
- `experiment-stats.json` documents the append-only event vocabulary and the
  exact aggregate fields covered by the deterministic stats test.

The fixtures contain no MemOS credentials or user content.
