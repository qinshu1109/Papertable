# TASK-010 replay fixtures

These schema-v1 fixtures preserve the Agent capability-admission contract for
TASK-013. They contain only structural statuses and safe explanations: no
keys, raw upstream bodies, reasoning, protocol payloads, or absolute paths.

- `three-stage-admitted.json` — all three native-tool stages pass for the
  current adapter and gateway shape.
- `three-stage-partial-failures.json` — each stage independently demonstrates
  fail-closed Agent unavailability.
- `invalidation-matrix.json` — TTL plus the four immediate invalidators and
  the required same-endpoint/model/protocol re-probe action.
- `stale-probe-concurrency.json` — concurrent requests share one probe and an
  old settings result cannot enter the cache.
