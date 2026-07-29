# TASK-022 verification

Date: `2026-07-29T19:43:59+08:00`

Branch: `task/TASK-022-safe-final-preview`

Worktree: `/private/tmp/papertable-task022`

## Result

Candidate complete: 8/8 task items implemented. The card remains
`in_progress` until independent supervisor acceptance.

Final synthesis now has two deliberately separate channels:

- an attempt-scoped, Store-only preview that can be rendered while formal
  `Turn.content` is empty;
- the unchanged formal token path, released only after the complete response
  passes sentinel, protocol, empty-response, length, and citation validation.

The preview map and gates are not members of `Turn`, `Card`,
`WorkspaceSnapshot`, Dexie, SQLite, backup, or export formats. Reset, repair,
stop, error, and reload discard preview state without a rollback write.

## Acceptance evidence

- Safe final prose streams after the sentinel while IndexedDB still contains
  `status=streaming` and `content=""`.
- Every actual synthesis request, including transport retry and deterministic
  repair, starts a new preview attempt.
- A complete protocol tag clears and blocks its attempt. Possible protocol
  prefixes split across chunks are withheld, including normalized/zero-width
  variants.
- `[[source:...]]` controls never appear as preview citations; the one formal
  commit still uses `controlledCitations`.
- Protocol repair persists one repair event and commits only the validated
  replacement answer.
- Stop and page reload leave formal content blank/interrupted and restore no
  preview from IndexedDB.
- A response without the sentinel has no live preview and arrives only through
  the formal path.
- Ordinary no-library streaming, exploration output, read-only citations, and
  existing persistence/export behavior remain covered by the full suites.

## Commands and results

| Command                                                                                                                                                                | Result                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                                                                                                                                          | Passed: typecheck, ESLint, Prettier, 273/273 Node/TypeScript/server tests, Rust 97 passed + 1 expected ignored live-MemOS test, Web production build |
| `pnpm test:e2e`                                                                                                                                                        | Final clean rerun passed 44/44                                                                                                                       |
| `pnpm exec playwright test ... --grep "answer-mode chip changes" --repeat-each=3`                                                                                      | Passed 3/3; classified the earlier full-suite timeout without changing product or existing test                                                      |
| `./node_modules/.bin/tsx --test src/lib/storage/dexie.test.ts src/lib/formats.test.ts src/lib/backup.test.ts src/lib/context.test.ts src/lib/synthesisPreview.test.ts` | Passed 51/51 persistence/export/preview tests                                                                                                        |
| `pnpm build:desktop`                                                                                                                                                   | Passed                                                                                                                                               |
| `/Users/qinshu/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`                                                                                   | Passed                                                                                                                                               |
| `/Users/qinshu/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`                                               | Passed                                                                                                                                               |
| `git diff --check`                                                                                                                                                     | Passed                                                                                                                                               |

The first full Playwright run passed 43/44; both TASK-022 cases passed, while
one pre-existing case approached its five-second assertion limit. That case
then passed 3/3 in isolation, and the complete suite passed 44/44 on a clean
rerun. The full sequence and all fixture-only failures encountered while
building the new coverage are retained in `harness-rebuild/logs/TASK-022.md`.

Playwright rewrote screenshots owned by TASK-009, TASK-010, and TASK-012 during
the run. They were restored byte-for-byte from the untouched TASK-021
dependency worktree and are excluded from this candidate.
