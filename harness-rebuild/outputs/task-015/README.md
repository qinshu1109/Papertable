# TASK-015 deterministic fixtures

The JSON files are content-free host-boundary fixtures used by
`src/lib/verdicts/context.test.ts`.

- `injection-on.json`: a confirmed same-project chain tail is injected.
- `injection-off.json`: the same hit is frozen for audit but A/B injection is
  disabled.
- `cross-project.json`: a foreign project row is excluded.
- `unavailable.json`: MemOS failure is explicit and injects nothing.
