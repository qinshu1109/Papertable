# TASK-018 release gate

Status: **IN_PROGRESS**

The implementation and deterministic release gates pass:

- `pnpm verify`: 257 Node/TS/server tests and 97 Rust tests passed.
- Playwright: 40/40 passed.
- Desktop bundle, real Computer Use interaction, Rust fmt, strict Clippy,
  live Rust→MemOS contract, L2 workspace validation, and `git diff --check`
  passed.
- TASK-014's verified no-key snapshot contains the verdict Cube and its
  isolated restore retained exact verdict records.

The event gate cannot pass yet:

- No user-frozen table of ten real old questions and recurrence rules exists,
  so no flagship-model A/B was run.
- The installed desktop database contains 0/20 real eligible reroutes and
  0/10 settled tombstone drafts.

TASK-018 therefore remains `in_progress`. Placeholder questions, deterministic
fixtures, and generated events were not counted as real evidence.
