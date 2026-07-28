# Governance update — 2026-07-28

- Source: [Papertable Harness 13 卡持续执行计划](../sources/INPUT-20260728-002.md)
- Branch: `governance/harness-orchestration-v2`
- Integration target: `feat/readonly-note-harness-alpha`
- PR: [#3](https://github.com/qinshu1109/Papertable/pull/3)
- Status: user gate satisfied; ready to merge

## Changes

- Main lane fixed as serial; TASK-012 is the only conditional second lane.
- Added supervisor-owned acceptance, per-card logs, repair limits, explicit WenzMark settings, and Git pathspec rules.
- Moved Rust `readableIds` data-layer validation from TASK-012 to TASK-007.
- Reconciled TASK-001 with PR #2, merge SHA, remote CI, local regression, and WenzMark UI.
- Prepared the seven-ADR summary and consistency review.
- Captured the user's blanket project authorization in `sources/INPUT-20260728-003.md`; ADR-001~007 are accepted and TASK-011 is pre-authorized.

## Authorization

The user explicitly directed that all Papertable Harness gates pass by default and that execution continue without further authorization prompts until all 13 cards pass. After validation and CI, merge this governance PR and create TASK-002.
