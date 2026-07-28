# TASK-005 replay fixtures

These fixtures capture budget-ledger semantics for TASK-013. They assert
limits, used/remaining invariants, the causal exhaustion reason, provider
usage provenance, and the append-only event/reopen contract rather than model
wording.

- `rounds-exhausted.json` — four exploration rounds, then successful bounded synthesis.
- `calls-exhausted.json` — the final allowed tool call executes before bounded synthesis.
- `wall-exhausted.json` — elapsed wall time crosses the run limit between complete steps.
- `tokens-exhausted.json` — real provider usage reaches the token limit; an unreported synthesis remains explicit.
- `persistence-reopen.json` — schema-v1 `budget-added` events and the run checkpoint agree after reopen.
