# TASK-012 lifecycle evidence

Schema-v1 fixture: `lifecycle-fixtures.json`.

The focused Web lifecycle test exercises app-owned byte snapshots, per-card
search/read isolation, explicit promotion, deletion, and frozen citation
evidence. Rust tests additionally exercise recursive enumeration, symlink
rejection, in-memory-only source paths, streamed snapshot ownership, cancelled
partial cleanup, the separate attachment run allowlist, guessed-ID rejection,
and separate formal-library promotion.

Playwright screenshots:

- `screenshots/imported-card-scope.png`
- `screenshots/limit-confirmation.png`
- `screenshots/explicit-promotion.png`
- `screenshots/deleted-source-frozen-excerpt.png`

The screenshot text and IDs are synthetic acceptance data only.
