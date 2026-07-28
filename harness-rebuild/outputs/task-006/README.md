# TASK-006 replay fixtures

These fixtures preserve successful-call no-progress semantics for TASK-013.
They assert canonical signature identity, suppression without call-budget
consumption, the single-reminder transition, bounded same-model synthesis,
evidence qualification, and schema-v1 event/checkpoint persistence.

- `first-repeat-reminder.json` — the second occurrence is suppressed, emits one
  reminder, and the same model chooses a different tool action.
- `qualified-no-progress.json` — the third occurrence stops exploration and
  synthesizes `partial/no_progress` from actually read evidence.
- `insufficient-no-progress.json` — the third occurrence has no qualified read
  evidence and returns an explicit no-progress refusal without an invented
  answer.
- `persistence-reopen.json` — both duplicate events and the `no_progress`
  checkpoint survive close/reopen transactionally under event schema v1.
