# TASK-011 deletion report

## Source measurements

The same `rg --files` scope was used before and after: production is
`src/`, `server/`, and `src-tauri/src/` TypeScript, JavaScript, and Rust with
test paths excluded; tests are `*.test.ts`, `*.test.mjs`, Rust test modules,
and `e2e/*.spec.ts`.

| Scope                           | Before |  After | Delta |
| ------------------------------- | -----: | -----: | ----: |
| Production files                |     76 |     76 |     0 |
| Production lines                | 33,117 | 32,795 |  -322 |
| Test files                      |     29 |     28 |    -1 |
| Test lines                      | 10,149 | 10,229 |   +80 |
| `src/lib/agent.ts`              |  2,130 |  1,809 |  -321 |
| `src/lib/agent.test.ts`         |  1,117 |  1,212 |   +95 |
| `agentProtocolPipeline.test.ts` |    546 |    574 |   +28 |
| `agentStateMachine.test.ts`     |     43 |      0 |   -43 |

The test-line increase is the new objective no-fallback coverage and
schema-v1 evidence assertion. The production reduction is physical deletion,
not minifier-only dead-code elimination.

## Deleted symbols and tests

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
- `src/lib/agentStateMachine.test.ts`, which existed only to execute the
  legacy A-Q matrix
- legacy H-path test scaffolding, labels, comments, and architecture copy

There is no production definition, import, call, or branch for any deleted
symbol. Library-backed execution now enters only the admitted native state
machine. Ordinary no-library general chat and the local sources-only refusal
remain separate deterministic paths.

## Bundle and build measurement

Both measurements used `pnpm build` from the same branch and dependency
state.

| Asset                              |    Before |     After |    Delta |
| ---------------------------------- | --------: | --------: | -------: |
| Main JavaScript, exact bytes       |   784,590 |   784,085 |     -505 |
| Main JavaScript, Vite display      | 755.93 kB | 755.43 kB | -0.50 kB |
| Main JavaScript gzip, Vite display | 256.47 kB | 256.45 kB | -0.02 kB |
| Chunk worker                       |     4,937 |     4,937 |        0 |
| Search worker                      |    19,386 |    19,386 |        0 |
| CSS                                |    55,603 |    55,603 |        0 |
| Secondary index JavaScript         |     2,933 |     2,933 |        0 |
| Total `dist` allocation (`du -sk`) |    860 KB |    860 KB |        0 |

The final build passed after 2,001 modules were transformed. The existing
greater-than-500 kB chunk warning remains. A 505-byte main-asset change is
below meaningful bundle-size noise, so TASK-011 claims no material bundle
win.

## Schema-v1 no-fallback and replay evidence

`no-fallback-replay.json` records failed probe, unknown capability, adapter
mismatch, provider invalid response, and exhausted protocol repair as
`failed/protocol_error`, with zero host-search and zero downgraded-workflow
calls. `src/lib/agent.test.ts` loads and asserts the fixture.

Objective runtime tests also assert:

- failed and unknown capability never reach provider, search, or read;
- adapter mismatch fails before provider, search, or read;
- provider invalid response performs one exact capability re-probe, emits no
  answer, and never reaches search or read;
- repair exhaustion never executes host retrieval or heuristic completion;
- capability TTL expiry and adapter/gateway-shape changes invalidate the exact
  cache entry for re-probe;
- normal no-library chat streams once without tools or retrieval;
- sources-only with no material refuses locally.

The TASK-004 A-Q fixture remains only as inert historical replay data. Its
schema-v1 TASK-011 descriptor explicitly marks it `executable: false` and
`callable: false`; no production or test symbol imports that matrix.

## Retained historical-string classification

The final exhaustive search intentionally retains old strings only in these
classes:

1. `src-tauri/src/db.rs` test fixtures contain serialized legacy `agent_run`
   JSON. They prove old records still round-trip and remain readable without
   event backfill; they do not select execution.
2. `src/lib/storage/dexie.test.ts` and
   `src/lib/provider/capabilityGate.test.ts` contain pre-admission cache rows.
   They prove old booleans are invalidated rather than upgraded into
   capability.
3. `harness-rebuild/sources/`, accepted ADR history, prior task cards/logs,
   and prior outputs are immutable research/audit history. The isolated
   TASK-001 probe under `outputs/task-001/` is not packaged or imported.
4. `TASK-011.md`, `CURRENT.md`, and this TASK-011 log/report name the deleted
   targets as governance and audit evidence.
5. The pre-existing untracked `qa-evidence/` database export is user-owned
   historical QA evidence and was left untouched.

All production and test-source hits for `two-stage`, `streamingToolCalls`, and
`toolResultAccepted` are therefore serialized migration/readability fixtures,
not executable workflow code. Searches for `runTwoStage`, `planQueries`, the
deleted helpers/matrix, and host-fallback labels return no production or test
definitions or calls.

## Verification summary

- Focused Agent/provider suite: 49/49 passed.
- `pnpm verify`: typecheck, ESLint, Prettier, 211/211 TypeScript/server tests,
  88/88 Rust tests, and production build passed.
- Strict Rust: `cargo fmt -- --check`, clippy with all targets/features and
  `-D warnings`, and 88/88 tests passed.
- Full Playwright: 35/35 passed.
- Workspace L2 validator: `ok: true`, zero errors; only the existing accepted
  ADR confirmation reminders were reported.
- All harness evidence JSON outside dependency `node_modules` parsed with
  `jq`; TASK-001 dependency JSONC/tsconfig files were correctly excluded.
- `pnpm format:check` and `git diff --check` passed.
