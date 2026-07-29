# TASK-023 verification

Candidate status: **accepted and merged** by the supervisor in PR #23
(`13f5ada293e3e09a8b0359343dadfad9ec658040`).

## Capability result

- Same 300ms loopback provider as the serial baseline.
- Serial totals: `990 / 926 / 923ms`, median **926ms**.
- Parallel totals: `679 / 618 / 618ms`, median **618ms**.
- Improvement: **308ms / 33.26%**.
- Stage 1 remains before stage 2; stage 3 starts independently.
- Every final stage records `durationMs`.
- Tauri progress events contain only stage, status, and duration.
- Existing non-streaming/non-streaming/streaming timeouts remain
  `90s / 90s / 45s`.

Raw data:

- `capability-serial-baseline.json`
- `capability-parallel-result.json`

## Real flagship result

- Provider model: `claude-opus-5`.
- Real material: 123 `harness-rebuild` Markdown files, 913 chunks.
- Frozen q1-q5 median:
  - `preflight=1ms`
  - `firstVisible=31648ms`
  - `total=31648ms`
  - `heartbeatGap=254ms`
- TASK-019 median:
  `preflight=1ms / firstVisible=36516ms / total=36516ms`.
- First visible and total improved **4868ms / 13.33%**; preflight remained
  1ms.
- q1-q10 all completed with actual search, actual read, read IDs previously
  returned by search, and controlled citations.
- q3 completed after eight tool calls and nine provider requests while the
  Desktop runtime had no fixed 4-round/8-call termination.
- Installed-window samples returned in 92ms during capability probing and
  68ms during real answer generation. The Node evidence runner's 254ms gap is
  not the decisive UI gate because it rebuilds its lexical index on its own
  event loop.

Raw data:

- `real-material-acceptance.json`
- `real-q2-authority-recheck.json`

## Recorded failures and fixes

1. The first real admission failed stage 2 with a safely mapped HTTP 400.
   Current reasoning gateways require a non-empty assistant
   `reasoning_content` on tool-result continuation. The v2 adapter now sends a
   fixed `tool-call-continuation` marker, never model reasoning. Old capability
   caches invalidate by adapter version.
2. One later real admission fluctuated before q2 and stopped safely. The
   immediate same-config probe passed all stages (streaming 14.379s, below the
   unchanged 45s timeout); one retry completed.
3. Manual answer review rejected the original q2 because it exposed a real
   sources-only gap: search hits could release unread prose. The strict gate now
   requires an actual read or host-frozen formal source and otherwise returns
   `refused/insufficient_evidence`. General-mode search summaries are unchanged.

## Regression gates

- `pnpm verify`: 276/276 Node/TypeScript/server tests, 102/102 Rust tests, one
  existing live-MemOS integration ignored by design, production Vite build.
- `pnpm test:e2e`: 44/44.
- `cargo fmt --check`: passed.
- `cargo clippy --all-targets --all-features -- -D warnings`: passed.
- `git diff --check`: passed.
- Desktop build/install/window verification: passed.

## Installed Desktop candidate

- Source candidate: `90e509d47`.
- Command: `pnpm desktop:signed`.
- Installed path: `/Applications/Papertable.app` (the build DMG was ejected;
  no second Papertable bundle remains under `/Applications` or `/Volumes`).
- `codesign --verify --deep --strict`: passed.
- Bundle/version/signature: `com.papertable.app / 0.1.0 / ad-hoc`.
- The installed binary contains build commit `90e509d47`; the Settings build
  panel showed the same commit and installed binary path.
- Provider configuration remains `-rw-------` (`0600`) and the API secret was
  masked in Settings.
- Ordinary “测试连接” returned in 595ms and did not enter capability-probe
  progress.
- Manual “立即重新探测” showed stage 1 and independent stage 3 running while
  stage 2 was still pending. Final durations were:
  `toolCallEmission=4080ms`,
  `toolResultAcceptance=2239ms`,
  `streamingToolCallDelta=3163ms`; all passed.
- A real installed-app question showed its first running state in 492ms,
  advanced to round 2 with one search and four hits, remained responsive
  (68ms UI sample), and rendered the final body.

Screenshots:

- `screenshots/installed-capability-probe-running.jpeg`
- `screenshots/installed-capability-probe-passed.jpeg`
- `screenshots/installed-agent-streaming.jpeg`
- `screenshots/installed-agent-final.jpeg`

## Release conclusion

**Accept.** The capability latency optimization preserves the stage 1 → stage
2 dependency, runs independent stage 3 concurrently, fails closed, emits only
safe progress metadata, and passes deterministic, real-provider, full
regression, installed-app identity, and visible-window responsiveness gates.
The original q2 and admission failures remain in the raw evidence rather than
being hidden.

Supervisor review found no blocking issue. Remote `rust` and `verify` checks
passed, and PR #23 merged into `task/TASK-014-verdict-memos`.
