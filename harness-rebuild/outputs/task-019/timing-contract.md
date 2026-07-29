# TASK-019 timing contract

All values are integer elapsed milliseconds derived from the same monotonic
`Date.now()` wall-clock source used by the existing Agent trace. The persisted
record contains durations and counts only.

- `send`: the accepted send/retry/continue action, captured before local turn
  creation and persistence.
- `first-model-request`: immediately before the first capability-probe,
  streaming, or non-streaming provider request is invoked. This is a local
  dispatch boundary, not the first network token.
- `first-visible`: the first non-empty text released by the answer gate, or the
  first explicit host terminal/refusal/error shown when no正文 is released.
- `finished`: immediately before the terminal turn state is committed to the
  Store.

Derived fields:

- `preflightMs = first-model-request - send`
- `firstVisibleMs = first-visible - send`
- `totalMs = finished - send`

The optional `AgentRunTrace.performance` object is emitted only for a host run
that supplied a send timestamp. A no-request host terminal can omit
`preflightMs`; ordinary real-provider runs record all three fields. Resume and
retry actions start a new measurement at the accepted action while preserving
the existing Agent run/audit semantics.
