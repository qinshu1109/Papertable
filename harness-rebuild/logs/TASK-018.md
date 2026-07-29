# TASK-018 execution log

- Branch: `task/TASK-014-verdict-memos` (TASK-014～017 verified candidates are
  present in the same uncommitted workspace)
- Started: `2026-07-29T05:36:59+08:00`
- Status: `in_progress`
- Execution: direct Codex persistent goal
  `019faaa8-91e6-7be1-8e34-aac6271b22d7`

## Checkpoints

- Read TASK-018, ADR-008, all dependency cards/logs/outputs, workspace rules,
  the App/Store/CardStage/GraphNavigator/ViewState flow, both verdict
  transports, and the installed desktop event database.
- Confirmed the dependency candidates are present and previously passed Web,
  Rust, Playwright, desktop-build, and MemOS contract gates.
- Added a MemOS-only project-entry ledger without a local verdict table or
  snapshot fallback. Reopening and project switching default to the ledger;
  continuing restores the existing last card and exploration workspace.
- Added chain-tail grouping, user-expanded superseded history, local-only
  verdictTrace reuse counts, explicit unavailable/retry UI, focused tests, and
  browser coverage.
- Added a real-provider A/B runner and deterministic event-gate scorer. The
  runner requires exactly ten pre-frozen human cases and leaves recurrence
  judgments null for human scoring.
- Read-only inspection found zero real reroute-eligible/tombstone settlement
  events in the installed desktop database. No event or A/B fixture was counted
  as a real sample.
- `pnpm verify` passed 255 Node/TS/server tests, 97 Rust tests, and the Web
  production build. Playwright passed 40/40 after every reload/project-switch
  scenario was updated to assert the new ledger entry layer.
- Desktop bundle, Rust fmt, strict Clippy, `git diff --check`, live Rust→MemOS
  contract, and L2 workspace validation all passed.
- Computer Use launched the debug `.app` against the real desktop database:
  startup showed the MemOS-backed ledger, “继续上次探索” restored the last card,
  switching to B站引流 returned to the ledger, and continuing again restored
  that project's last card. Screenshots are in `outputs/task-018/screenshots/`.
- Independent supervisor review found and repaired the combined-query recall
  defect in TASK-015, tightened Node/Rust source and supersede validation, and
  reran 257 Node/TS/server tests, 97 Rust tests, 40 Playwright tests, strict
  Clippy, live Rust→MemOS, workspace validation and `git diff --check`.
- A freshly rebuilt, ad-hoc-signed debug candidate was installed and checked
  with the real desktop database. Project entry, continue, project switch and
  empty-suffix reroute behavior passed. The temporary non-eligible branch was
  stopped and moved to the recoverable trash; it was not counted.
- MemOS currently caps search at 50 records and exposes no pagination cursor.
  This does not block the present 0/20 event gate, but the ledger/query window
  is recorded as implementation debt before the Cube grows beyond 50 rows.
- Added a zero-dependency read-only desktop event scorer. It invokes the
  platform `sqlite3 -readonly`, authenticates row identity/project/time against
  each event document, filters to verdict events, and aggregates unique
  project+branch-card lifecycles. Duplicate eligible/settlement rows and orphan
  settlements cannot inflate the gates. `pnpm acceptance:task-018:desktop`
  successfully read the installed database and still reports 0/20 and 0/10.
- `2026-07-29T06:26:29+08:00` — Third consecutive goal audit found the same
  external state: no frozen ten-case A/B table and the authenticated desktop
  scorer still reports 0/20 eligible reroutes and 0/10 settled drafts. No
  further in-scope engineering can satisfy these empirical gates without
  fabricating user actions, so the execution goal is formally blocked while
  TASK-018 correctly remains `in_progress`.

## Open event gates

- Ten user-selected old questions and their frozen recurrence rules are absent.
- The installed desktop database has 0/20 eligible reroutes and 0/10 settled
  tombstone drafts.
- Per TASK-018, the card stays `in_progress`; these counts cannot be simulated.
