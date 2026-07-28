# TASK-009 replay fixtures

These schema-v1 fixtures preserve the UI projection contract for TASK-013.
They assert persisted-event rendering, terminal/budget presentation, protocol
repair and interruption visibility, and trajectory promotion without source
authority.

- `live-reload-timeline.json` — live append order and identical projection
  after reload.
- `terminal-budget-matrix.json` — legal result/reason states, accepted copy,
  truncation visibility, and TASK-005 limits/used/remaining.
- `repair-interruption-visibility.json` — deterministic versus model-resend
  repair, retry, no-progress, and interrupted checkpoint presentation.
- `promotion-authority-boundary.json` — existing `child` inherit relation,
  administrative trace backlink, empty promoted facts, and forbidden
  authority-bearing fields.

Reviewed screenshots are stored under `screenshots/`.
