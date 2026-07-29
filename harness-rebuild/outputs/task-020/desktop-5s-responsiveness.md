# TASK-020 desktop five-second responsiveness

Captured: `2026-07-29T18:45:49+08:00`

## Isolation and fixture

- Built a dedicated debug application with identifier
  `com.papertable.task020.qa`; its Settings page reported the isolated
  identifier, app bundle, and data directory. The formal Papertable process
  was closed during the run and restored afterwards.
- The provider was the standard-library fixture
  `delayed-openai-provider.mjs` at `http://127.0.0.1:18888/v1`, with
  `PAPERTABLE_FAKE_LLM_DELAY_MS=5000`.
- A temporary 50 ms browser heartbeat was injected only into the QA bundle.
  The probe was removed from `index.html` before the committed build and full
  gates.

## Simultaneous desktop interaction

An explicit connection test was started from the Composer. Before its
five-second response could finish, Computer Use switched from the `波函数`
card to the `量子计算机与极低温` root card, armed the heartbeat, and dragged
the native window:

| Observation                                   |    Result |
| --------------------------------------------- | --------: |
| Command dispatch                              |     15 ms |
| Accessibility state available after dispatch  |    469 ms |
| Card-switch dispatch                          |    244 ms |
| Switched card visibly confirmed               |    889 ms |
| Window-drag control call                      |    321 ms |
| All interactions complete after request start |  2,554 ms |
| Heartbeat maximum during interaction          | **53 ms** |
| Heartbeat samples during interaction          |        12 |
| Heartbeat maximum after delayed response      | **53 ms** |
| Heartbeat samples after delayed response      |       236 |
| Required maximum                              |    250 ms |

The delayed provider recorded the request, the card remained on
`量子计算机与极低温` after completion, and `53 ms <= 250 ms`.

## Frozen-question timings

The five exact questions from TASK-019 were then submitted serially through
the packaged desktop UI. Values below were read back from
`turns.agent_run.performance` in the isolated QA SQLite database:

| Case       | TASK-019 baseline preflight / first visible / total | TASK-020 5 s fixture preflight / first visible / total |
| ---------- | --------------------------------------------------: | -----------------------------------------------------: |
| q1         |                              3 / 24,909 / 24,909 ms |                                  24 / 5,036 / 5,036 ms |
| q2         |                              1 / 36,516 / 36,516 ms |                                  63 / 5,077 / 5,077 ms |
| q3         |                              0 / 22,970 / 22,970 ms |                                  23 / 5,042 / 5,042 ms |
| q4         |                              1 / 67,828 / 67,828 ms |                                  26 / 5,037 / 5,037 ms |
| q5         |                              1 / 60,857 / 60,858 ms |                                  42 / 5,051 / 5,051 ms |
| **median** |                          **1 / 36,516 / 36,516 ms** |                              **26 / 5,042 / 5,042 ms** |

The baseline used the real configured provider and native note tools, while
the post-run intentionally used a deterministic one-request local fixture
without a bound library. This comparison proves the same timing fields remain
populated and that the UI stays live through a known five-second stall; it is
not an apples-to-apples model-performance claim.
