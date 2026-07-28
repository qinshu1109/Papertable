# TASK-009 execution log

- Branch: `task/TASK-009-event-timeline`
- Started: `2026-07-28T13:58:35+08:00`
- Status: `in_progress`
- WenzMark task ID: `13f96c73-ec38-4f26-81c9-963b59e30bfb`

## Checkpoints

- `2026-07-28T13:58:35+08:00` — Confirmed the requested branch and preserved the pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/` files.
- `2026-07-28T13:58:35+08:00` — Read the required workspace context, TASK-009 and dependency cards/logs/outputs, accepted ADR-002/003/004/006, cited research sections, event audit/persistence, terminal and budget contracts, CardStage/store relation paths, citation/reference controls, and related tests directly in the requested order.
- `2026-07-28T14:14:39+08:00` — Completed the schema-v1 event projection, live persisted-event consumer, terminal/reason/budget presentation, safe source expansion, trajectory promotion, deterministic fixtures, browser evidence, and scope audit. Left the card `in_progress` for supervisor acceptance.
- `2026-07-28T14:16:50+08:00` — Cross-checked the finished UI directly against TASK-005's accepted card, execution log, and all five replay fixtures: the four persisted axes, zero-clamped remaining values, exhaustion reasons, and explicit unreported/partial token semantics match.
- `2026-07-28T14:20:00+08:00` — Supervisor independently confirmed WenzMark `awaitingAcceptance` with exit code 0, reviewed the Git scope and screenshot evidence, reran the focused authority/terminal tests, the complete repository gate, and all 32 Playwright cases. All passed; accepted for PR.

## Tests

- Focused event, terminal, and budget suite:
  - `pnpm exec tsx --test src/lib/agentTimeline.test.ts src/lib/agentEvents.test.ts src/lib/agentTerminal.test.ts src/lib/agentBudget.test.ts src/lib/agentBudgetAudit.test.ts`
  - PASS: 20/20 tests.
- Final trajectory projection/context-authority suite:
  - `pnpm exec tsx --test src/lib/agentTimeline.test.ts`
  - PASS: 7/7 tests.
- Targeted browser suite:
  - `pnpm exec playwright test e2e/papertable.spec.ts --grep "继续深挖|persisted Agent events|repair, no-progress" --reporter=line`
  - PASS: 3/3 tests.
- Required repository gate:
  - `pnpm verify`
  - PASS: typecheck, lint, format, 220 TypeScript/server tests, 87 Rust tests, production build.
  - The first run exposed an ESLint `no-control-regex` violation in the new safe-text sanitizer. The sanitizer was rewritten as a code-point filter; the final complete run passed. The build retained only the pre-existing large-chunk advisory.
- Full browser suite:
  - `pnpm test:e2e -- --reporter=line`
  - PASS: 32/32 tests, including existing citation, stop/reload, continuation, and 390 px viewport coverage.
- Workspace and fixture validation:
  - `python3 /Users/qinshu/.codex/skills/init-ai-project-workspace/scripts/workspace_builder.py validate --root /Users/qinshu/Documents/Codex/2026-07-25/https-b23-tv-cq1kdqg/papertable/harness-rebuild`
  - PASS: `ok: true`, zero errors. Warnings are the expected ADR-001–ADR-007 acceptance-confirmation reminders; the ADR files cite the user's recorded confirmation.
  - `jq empty harness-rebuild/outputs/task-009/*.json`
  - `jq -e '.schemaVersion == 1' harness-rebuild/outputs/task-009/*.json`
  - PASS: all four replay fixtures are valid schema-v1 JSON.
- Formatting and patch hygiene:
  - `pnpm format:check`
  - `git diff --check`
  - PASS.
- Rust product code was not touched. The Rust gate nevertheless passed as part of `pnpm verify` (87/87).

## Scope audit

- Product changes are limited to the timeline projection/component, CardStage integration, trajectory-promotion origin type, timeline styles, deterministic unit/E2E coverage, and TASK-009 harness artifacts.
- The existing append-only event writer, schema-v1 persistence, agent runner, terminal mapper, budget calculator/audit, context builder, controlled-citation store, Rust persistence, server, dependencies, and lockfile are unchanged.
- Promotion uses the existing `createCard` relation path with a `child` edge and `topic-and-selection` context policy. The promoted card stores only an administrative run/event backlink and safe display title; it receives no copied facts, turn history, citations, references, anchors, search snippets, protocol payloads, hidden reasoning, or absolute Vault path.
- Timeline data APIs expose no citation/reference/anchor fields. UI nodes expose only expansion and promotion controls; the controlled quote/reference entry points remain restricted to real source material.
- Existing TASK-008 `继续深挖` integration remains in place and is covered by unit/browser gates.
- `git diff --cached --name-only` was empty. No file was staged, committed, pushed, merged, or switched.
- The pre-existing untracked `QA_REPORT.md`, `conversation-2026-07-27-084611.txt`, and `qa-evidence/` remain untouched.

## Unresolved risks

- Live rendering polls the persisted audit adapter every 140 ms while a run is advancing. This intentionally reflects append-only step events, not token deltas.
- Unsupported or legacy audit schemas intentionally render no trajectory rather than reconstructing prose.
- Providers may omit token usage. In that case the authoritative budget row remains visible and explicitly says `未报告`; the other three axes still show exact limits, used, and remaining values.
- Promotion preserves administrative traceability without factual authority. Any later factual content on that real card must be added through the normal governed card/source workflows.

## Acceptance

Supervisor technical acceptance: PASS. TASK-009 remains `in_progress` until its PR and CI are merged.
