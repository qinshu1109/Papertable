# TASK-023 acceptance matrix

## Frozen inputs

- Integrated base: `f8b84bf`
- TASK-019 real-provider median: `preflight=1ms`,
  `firstVisible=36516ms`, `total=36516ms`
- TASK-021 deterministic host-preflight median: `preflight=94ms`
- TASK-020 delayed Desktop responsiveness: heartbeat max `53ms` under a
  `250ms` gate
- Capability serial fixture: three provider responses, each delayed `300ms`
- Real material set: this repository's `harness-rebuild/` Markdown documents,
  imported as one read-only Desktop note library
- Questions: `real-material-questions.json`

## Gates

| Area                | Required evidence                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability timing   | Every final stage has a non-negative `durationMs`; no prompt, tool arguments, key, response body, or reasoning is emitted or stored                                  |
| Dependency          | `toolCallEmission` completes before `toolResultAcceptance` starts                                                                                                    |
| Concurrency         | `streamingToolCallDelta` starts independently; total approaches `max(stage1 + stage2, stage3)`                                                                       |
| Progress            | Desktop “立即重新探测” receives start/pass/fail events through a Tauri Channel and shows the current stage plus final milliseconds                                   |
| Failure             | Stage failure and timeout fail closed; dependent stage stays not-run; all workers finish before the command returns                                                  |
| Connection test     | Settings “测试连接” remains a separate `provider_health` call and does not start capability progress                                                                 |
| Five questions      | Exact TASK-019 q1-q5; record `preflightMs`, `firstVisibleMs`, `totalMs`, heartbeat, request/tool counts                                                              |
| Ten questions       | Each completed answer that makes a sourced claim has actual search, actual read, non-empty `readableIds`, and only controlled citations; no fixed 4-round/8-call cap |
| Regression          | `pnpm verify`, full Playwright, Rust tests, fmt, strict Clippy, Desktop build                                                                                        |
| Installed candidate | Build/version/commit, provider health, capability stages, window heartbeat, final preview, and real-provider interaction                                             |

## Final outcome

All gates passed for source candidate `90e509d47`. The installed bundle at
`/Applications/Papertable.app` reported the same commit, passed provider health
without starting capability probing, showed live Channel progress and final
stage timings, remained responsive during both probing and real generation,
and rendered the final preview. See `verification.md` and `screenshots/`.
