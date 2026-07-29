# TASK-023 execution log

- Branch: `task/TASK-023-capability-final-acceptance`
- Started: `2026-07-29T20:12:47+08:00`
- Status: `in_progress`
- Integrated base HEAD: `f8b84bf`
- Dependencies:
  - TASK-019: PR #19 / accepted baseline
  - TASK-020: PR #20 / merge `a12377e`
  - TASK-021: PR #21 / merge `78526d0`
  - TASK-022: PR #22 / merge `f8b84bf`
- Execution: direct Codex persistent goal
  `019fadb4-6555-7431-b553-7c918dca8683` (no WenzMark task was supplied or
  available in this session)
- Worktree: `/private/tmp/papertable-task023`

## Checkpoints

- `2026-07-29T20:12:47+08:00` — Read `CONTEXT.md`, `CURRENT.md`,
  `PROJECT.md`, `AGENTS.md`, TASK-023, and the dependency task cards. The
  executor preserved the user's dirty primary worktree and created this
  isolated branch only after TASK-020, TASK-021, and TASK-022 passed local
  verification, E2E, strict Clippy, remote CI, and merge review.
- `2026-07-29T20:16:15+08:00` — Read the TASK-019 through TASK-022 cards,
  logs, source paths, and actual output artifacts. Froze the acceptance matrix
  and ten real-material questions under `outputs/task-023/`.
- `2026-07-29T20:16:15+08:00` — Measured the unchanged serial capability
  implementation against the TASK-020 loopback provider with a deterministic
  300ms delay per response. Three complete probes passed in `990/926/923ms`
  (median `926ms`), matching the source dependency `stage1 + stage2 + stage3`.
  The provider observed 9 requests over a shared two-connection process pool.
  Evidence: `outputs/task-023/capability-serial-baseline.json`.
- `2026-07-29T20:29:28+08:00` — Added per-stage `durationMs` and changed the
  scheduler to stage 1 -> stage 2 on the current blocking worker while a scoped
  stage-3 worker starts independently. The scoped worker is always joined;
  panic recovery fails closed. The Web host uses the same dependency shape and
  explicit 90s/90s/45s per-stage timeouts.
- `2026-07-29T20:29:28+08:00` — Added a safe Tauri progress-event schema with
  only `stage`, `status`, and optional `durationMs`. Rust serialization and the
  TypeScript normalizer both reject/drop raw detail, reply, tool arguments,
  key, and reasoning fields.

## Verification

- Targeted Node integration:
  `pnpm exec tsx --test server/config.test.mjs` — 3/3 passed. A delayed
  180ms/provider-response fixture observed stage 1 and stage 3 start within
  100ms, stage 2 only after stage 1, and a total below the three-response
  serial bound.
- Targeted provider/cache:
  `pnpm exec tsx --test src/lib/provider/http.test.ts
src/lib/provider/capabilityGate.test.ts` — 15/15 passed.
- Targeted Rust:
  `cargo test --manifest-path src-tauri/Cargo.toml llm::tests:: --lib` —
  21/21 passed, including scoped concurrency, panic-worker join/drop,
  missing-key fail-closed, and allowlisted progress serialization.
- Targeted UI:
  `pnpm test:e2e --grep "settings shows the three-stage Agent gate"` — 1/1
  passed. The test asserts that ordinary “测试连接” leaves the capability
  request count unchanged, manual re-probe adds exactly one request, and all
  three final timings render.
- `pnpm verify` — passed after fixing the first run's one unused-parameter lint
  and formatting the five newly added/edited evidence files. Final counts:
  275/275 Node/TypeScript tests, 102/102 Rust tests (one existing external
  MemOS integration ignored by design), and production Vite build passed.
- `pnpm test:e2e` — 44/44 passed in 1.1 minutes.
- `cargo fmt --check` and
  `cargo clippy --all-targets --all-features -- -D warnings` — passed.
- `2026-07-29T20:42:44+08:00` — The first real flagship run stopped before
  q1 because admission failed closed: stages 1 and 3 passed, while stage 2
  returned a safely mapped HTTP 400 in four consecutive probes. A direct
  status/schema-only matrix isolated the gateway contract: a non-empty
  `reasoning_content` is required on the assistant tool-call continuation,
  but the gateway accepts a fixed sentinel and does not require raw model
  reasoning. Added the constant `tool-call-continuation` only in the outbound
  Web/Rust wire adapters, bumped the adapter version to v2 to invalidate old
  capability caches, and retained the existing reasoning-drop gates.
  Targeted Node/TypeScript 18/18 and Rust 1/1 passed.
- `2026-07-29T20:51:49+08:00` — Real q1-q10 structural acceptance completed
  over 123 Markdown files / 913 real chunks. Every row performed search,
  actual read, validated every requested read ID against prior search output,
  produced controlled citations, and completed. q3 used eight tool calls and
  nine model requests without a legacy fixed-limit terminal. Manual answer
  review rejected the original q2: it cited the historical research report
  and exposed that sources-only treated a search hit as sufficient to release
  unread prose. Tightened the existing strict-evidence predicate to require an
  actual read (or host-frozen formal source), exactly matching ADR-004, and
  added a direct search-only refusal regression. The original q2 is retained
  in `real-material-acceptance.json` as the failure sample.
- `2026-07-29T20:55:38+08:00` — Documented the corrected q2 contract in the
  current task source: sources-only checks `readChunks` before releasing any
  deferred prose and returns `refused/insufficient_evidence` for search-only
  runs; general mode may still report search metadata. Controlled citation
  cleanup remains an independent second boundary.
- `2026-07-29T20:58:21+08:00` — The final q2 rerun first encountered one
  admission fluctuation and stopped before asking the question. Immediate
  same-config recheck passed all stages (streaming 14.379s under the unchanged
  45s timeout). One retry then completed q2 with one search, one actual read,
  one controlled citation to the current TASK-023 source, and the corrected
  `readChunks` / `refused/insufficient_evidence` explanation. Evidence:
  `outputs/task-023/real-q2-authority-recheck.json`.
- `2026-07-29T20:59:47+08:00` — Repeated the exact 300ms loopback capability
  fixture used for the serial baseline. Three totals were 679/618/618ms
  (median 618ms), 308ms / 33.26% below the 926ms serial median. Per-stage
  timings were 306-329ms and the total follows
  `max(stage1 + stage2, stage3)`. Nine requests used two pooled TCP
  connections. Evidence: `capability-parallel-result.json`.
- `2026-07-29T21:02:33+08:00` — Final post-fix regression passed from the
  beginning: `pnpm verify` (276/276 Node/TS, 102/102 Rust plus one existing
  live-MemOS ignore, production build), Playwright 44/44, Rust fmt, strict
  Clippy all-targets/all-features with `-D warnings`, and `git diff --check`.
- `2026-07-29T21:13:20+08:00` — Built the committed candidate with
  `pnpm desktop:signed`, installed it at `/Applications/Papertable.app`, and
  ejected the build DMG. `codesign --verify --deep --strict` passed; the only
  remaining app bundle is the installed copy with bundle ID
  `com.papertable.app`, version `0.1.0`, ad-hoc signature, and binary commit
  `90e509d47`. The provider file is still mode `0600`.
- `2026-07-29T21:13:20+08:00` — Exercised the installed app through visible
  macOS UI. Ordinary connection test returned in 595ms without starting a
  capability probe. Manual re-probe exposed the Channel event immediately:
  at 584ms stage 1 and stage 3 were running while stage 2 was not yet run.
  The final stage durations were `4080/2239/3163ms`, all passed. An in-flight
  accessibility/UI sample returned in 92ms.
- `2026-07-29T21:13:20+08:00` — Sent a real question in the installed app.
  The first running state appeared in 492ms, then showed round 2, one search,
  four hits, and zero reads while the provider was still running. A live
  window sample returned in 68ms and the final answer rendered. Screenshots:
  `outputs/task-023/screenshots/installed-capability-probe-running.jpeg`,
  `installed-capability-probe-passed.jpeg`,
  `installed-agent-streaming.jpeg`, and `installed-agent-final.jpeg`.

## Candidate result

- All executor gates passed. Candidate commit: `90e509d47`.
- Release recommendation: **accept**, subject only to independent supervisor
  diff review, push, remote CI, and merge.
- Task status deliberately remains `in_progress` until those supervisor gates
  complete.
