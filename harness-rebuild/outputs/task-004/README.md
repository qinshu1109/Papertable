# TASK-004 replay fixtures

These fixtures capture state-machine semantics, not answer wording. TASK-013
may replay them against later implementations and assert terminal state,
evidence retention, tool execution, and protocol-failure behavior.

- `legacy-exit-matrix.json` — the A–Q migration contract.
- `rounds-exhausted-partial.json` — four tool rounds, preserved read evidence,
  successful forced synthesis, and `partial/rounds_exhausted`.
- `empty-synthesis-protocol-error.json` — four tool rounds, two empty synthesis
  attempts, preserved evidence, no answer, and `failed/protocol_error`.
- `length-truncated-batch.json` — a `finishReason=length` tool batch is wholly
  discarded before successful bounded synthesis.
