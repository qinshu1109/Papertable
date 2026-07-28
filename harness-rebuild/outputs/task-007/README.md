# TASK-007 replay fixtures

These fixtures preserve retry classification, deterministic protocol repair,
Rust run-scoped read authority, and schema-v1 audit persistence for TASK-013.
They assert transitions and evidence rather than model wording.

- `retry-classification.json` — configuration, rate limit, transport, empty,
  and malformed-protocol policy rows with bounded attempts/backoff.
- `ambiguous-repair-success.json` — ambiguous streamed call → same-model native
  resend → complete legal call → real execution.
- `repair-exhausted-protocol-error.json` — no guessed name/token/brace and
  `failed/protocol_error` only after all same-protocol stages are exhausted.
- `rust-run-allowlist.json` — Rust accepts only chunks recorded by this run's
  own search and rejects frontend/cross-run/cross-project bypasses.
- `persistence-reopen.json` — retry, repair, rejection, capability invalidation,
  and terminal events survive reopen under append-only schema v1.
