# TASK-012 execution log

- Branch: `task/TASK-012-attachment-lifecycle`
- Started: `2026-07-28T15:48:16+08:00`
- Status: `in_progress`
- WenzMark task ID: `3d3858cf-2005-447a-82b5-3116c7afa909`

## Checkpoints

- `2026-07-28T15:48:16+08:00` — Confirmed the requested branch and preserved the pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/` files.
- `2026-07-28T15:48:16+08:00` — Read the required workspace context, TASK-012 card, TASK-003 dependency card/log (its isolated output directory does not exist), accepted ADR-004/005 plus directly required ADR-003, and `sources/research/papertable.md` sections 4–5 in the prescribed order.
- `2026-07-28T16:21:13+08:00` — Completed the native and Web lifecycle, scope freeze, controlled-citation deletion state, explicit promotion, schema-v1 fixtures, screenshots, formatting, workspace validation, and final scope audit. The card remains `in_progress` for supervisor acceptance.

## Tests

- Focused TypeScript:
  - `pnpm exec tsx --test src/lib/attachments/web.test.ts src/lib/agent.test.ts`
  - PASS: 26 tests. Covers app-owned Web byte snapshots, card isolation, explicit promotion, deleted-source citation resolution, default/hard limits, changed-selection rejection, and model scope-override rejection.
- Focused Rust:
  - `/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml attachments::tests -- --nocapture`
  - PASS: 5 tests. Covers deterministic recursive enumeration, symlink rejection, absence of exposed absolute paths, byte-snapshot independence, cancelled partial cleanup, separate attachment tables, per-run/card allowlist, guessed-ID denial, and promotion separation.
  - `/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml v10_migration_adds_harness_transport_allowlist_and_fts_without_rebuilding_turns -- --nocapture`
  - PASS: 1 migration test; the v11 attachment tables/allowlist are added without rebuilding turns.
- Full repository:
  - `pnpm verify`
  - PASS: typecheck, ESLint, Prettier check, 214 JS/TS/server tests, 93 Rust tests, and production build. Vite reports only its pre-existing large-chunk advisory.
  - `/Users/qinshu/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
  - PASS.
  - `/Users/qinshu/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
  - PASS.
  - `/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features`
  - PASS: 93 tests.
  - `pnpm test:e2e`
  - PASS: all 36 Playwright cases. TASK-012 evidence covers the 26-item confirmation dialog, imported card scope, explicit promotion, model-tool schema audit, deletion, frozen excerpt, and `原来源已移除`.
- Workspace and fixtures:
  - `python3 /Users/qinshu/.codex/skills/init-ai-project-workspace/scripts/workspace_builder.py validate --root /Users/qinshu/Documents/Codex/2026-07-25/https-b23-tv-cq1kdqg/papertable/harness-rebuild`
  - PASS: `ok: true`, L2/code, zero errors. Seven warnings are the existing reminders to retain user confirmation records for accepted ADR-001–007.
  - `jq -e '.schemaVersion == 1 and .taskId == "TASK-012" and (.scenarios | length == 4) and ([.scenarios[].id] == ["snapshot-import","host-frozen-scope","controlled-citation-after-delete","explicit-promotion"])' harness-rebuild/outputs/task-012/lifecycle-fixtures.json`
  - PASS; all four PNG evidence files are non-empty and were visually inspected.
- Final hygiene:
  - `pnpm format:check` — PASS.
  - `git diff --check` — PASS.
  - `git diff --cached --name-only` — empty; nothing staged.
  - Branch remains `task/TASK-012-attachment-lifecycle`.

### In-scope failures found and fixed

- The first `pnpm verify` run exposed two Web migration assertions still expecting Dexie v7. They now assert v8 and also verify empty attachment stores; the complete command then passed.
- The first strict Clippy run rejected two eight-argument Rust functions. Import parameters now use one typed `AttachmentImportRequest`; strict Clippy then passed.
- The first full Playwright run caught a TASK-012 wording regression in the existing library-only no-evidence path. The message now distinguishes attachment-only, library-only, and combined scopes; all 36 cases then passed.
- Full Playwright regenerated three TASK-009/010 screenshots. They were restored to their branch versions so TASK-012 does not modify another card's outputs.

## Changed file scope

- Native lifecycle and schema: `src-tauri/src/attachments.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/db.rs`, `src-tauri/src/schema.sql`.
- Web lifecycle and storage: `src/lib/attachments/*`, `src/lib/storage/dexie.ts`, `src/lib/storage/dexie.test.ts`, `src/lib/notes/scoped.ts`.
- Frozen Agent host scope and tests: `src/lib/agent.ts`, `src/lib/agent.test.ts`, `src/lib/agentEvents.ts`, `src/lib/agentBudgetAudit.ts`, `src/lib/agentResume.ts`.
- UI/state: `src/store.tsx`, `src/components/Composer.tsx`, `src/components/NoteSourcePreview.tsx`, `src/styles/base.css`.
- UI evidence and governance: `e2e/papertable.spec.ts`, `harness-rebuild/tasks/TASK-012.md`, this log, and `harness-rebuild/outputs/task-012/`.

## Guardrail decisions

- TASK-012 remains `in_progress` for supervisor acceptance.
- Global Rust `readableIds` / `agent_note_search_allowlist` behavior remains owned by TASK-007. `src-tauri/src/notes.rs` and `src-tauri/src/llm.rs` have no diff.
- Attachment records, chunks, FTS, and per-run grants use separate `attachments`, `attachment_chunks`, `attachment_chunks_fts`, and `agent_attachment_search_allowlist` storage. Import never writes formal note-library tables.
- `attachment:<cardId>` is frozen into the persisted host scope. The model schemas expose only `query`, `limit`, and `chunkIds`; extra scope/card/library/path input cannot change the host-selected card.
- Desktop source paths exist only in the transient Tauri drag/preflight job and copy request. Persisted rows contain a safe relative display path and an app-owned relative storage path. Symlinks and post-preflight source changes fail closed.
- Import uses staging plus atomic database insertion and removes partial staging/final snapshots on failure or cancellation.
- Promotion is a separate user action that copies readable text into `project-attachments-<projectId>` while retaining the original attachment scope.
- No files were staged, committed, pushed, merged, or used to switch branches.
- The pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/` remain present and untouched.

## Known limits

- All bytes can be snapshotted, but only recognized UTF-8 text attachments up to 20 MiB are indexed. Binary, invalid UTF-8, and larger text files remain visible as `仅快照`; there is no OCR, PDF text extraction, or archive expansion in this card.
- Web uses the deterministic multi-file input/test adapter and does not expose browser folder traversal. Native Tauri drag/drop is the path that recursively enumerates folders.
- Automated Playwright evidence runs against the Web adapter. Native filesystem ownership, folder enumeration, cancellation cleanup, source-change denial, separate FTS/allowlist, and promotion are covered by Rust tests rather than GUI automation.
- Native imports serialize SQLite access while a copy commits; progress and cancellation remain available, but unrelated native database commands wait for that bounded import.

## Supervisor acceptance

- `2026-07-28T16:27:00+08:00` — Supervisor independently reconciled WenzMark (`awaitingAcceptance`, exit `0`), the task log, branch, unstaged diff, protected QA files, and the objective verify criteria.
- Independently reran `pnpm verify`, `pnpm test:e2e`, the L2 workspace validator, and `git diff --check`: 214 JS/TS/server tests, 93 Rust tests, 36 Playwright cases, and workspace validation all passed.
- Reviewed the native per-run/card attachment allowlist, host-frozen checkpoint scope, scope-free model schemas, staged snapshot cleanup, explicit copy-only promotion, Web/Dexie separation, and deleted-source frozen citation behavior. Accepted for PR; the task card remains `in_progress` until merge closure.
