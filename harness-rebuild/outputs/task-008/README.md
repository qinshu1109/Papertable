# TASK-008 replay fixtures

These fixtures preserve same-run continuation, ADR-006 working-set
compaction, and crash/concurrency recovery for TASK-013. They assert
event/checkpoint state and citation authority rather than provider wording.

- `same-run-event-flow.json` — bounded partial terminal → one schema-v1
  budget extension → same run/turn → completed terminal.
- `seven-category-working-set.json` — the exact ordered provider working set;
  requested-only tools and full trajectory events are excluded.
- `crash-reopen.json` — interruption settles at the last committed cursor;
  an already committed continuation budget is not charged again.
- `double-resume.json` — two claims at one terminal cursor produce exactly one
  budget event/provider generation.
