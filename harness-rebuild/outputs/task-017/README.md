# TASK-017 adoption evidence

- `acceptance-matrix.json` maps Web/Desktop entry points, eligibility, dialog
  behavior, failure recovery, idempotency, supersede, project/source location,
  and persistence to executable checks.
- The focused TypeScript/Node suite covers confirmation, cancellation boundary,
  empty-handle rejection, write failure, repeat idempotency, supersede revision,
  project isolation, locked card/turn source attributes, Dexie, SQLite, and
  lossless package round trips.
- The Playwright adoption test proves the obsolete Web “收藏本轮” label is gone,
  cancellation leaves the Turn unminted, and explicit confirmation writes
  `favorite=true` plus `verdictId`.
- Desktop uses the same Store/dialog workflow from its whole-turn context menu;
  the desktop bundle and Rust SQLite tests verify that path compiles and the
  success marker round-trips.
