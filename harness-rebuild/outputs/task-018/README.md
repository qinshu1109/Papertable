# TASK-018 acceptance evidence

## Repeatable gates

1. Copy `ab-cases.example.json` outside Git, replace all placeholders with the
   ten user-selected old questions, confirmed tombstones, and frozen recurrence
   rules.
2. Run the real flagship-model matrix:

   ```sh
   pnpm acceptance:task-018 \
     --cases=/absolute/path/to/ab-cases.private.json \
     --out=harness-rebuild/outputs/task-018/ab-run.private.json
   ```

3. A human marks only each `off.recurrence` and `on.recurrence` boolean from the
   frozen rule. The script never asks a model to judge recurrence.
4. Settle both event gates directly from the installed desktop database
   (read-only; no export or product write):

   ```sh
   pnpm acceptance:task-018 \
     --score=harness-rebuild/outputs/task-018/ab-run.private.json \
     --desktop-db=auto \
     --out=harness-rebuild/outputs/task-018/final-gates.json
   ```

   To inspect the real event counters before the A/B file exists:

   ```sh
   pnpm acceptance:task-018:desktop
   ```

The scorer authenticates each SQLite row against its stored JSON, deduplicates
by project plus branch card, and ignores orphan settlement events.
`current-gates.json` records the latest real sample availability. It is
deliberately `in_progress`: no selected ten-case table and no eligible reroute
events existed, so the missing event volume is not replaced with fixtures.

## UI evidence

The Playwright ledger checks prove MemOS-only listing, project switching,
collapsed superseded history, retryable unavailability, the preserved
“continue last exploration” path, and mobile layout. Real desktop evidence and
the conditional release gate are in `screenshots/`, `supervisor-acceptance.md`
and `release-gate.md`.
