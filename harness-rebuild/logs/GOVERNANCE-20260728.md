# Governance update — 2026-07-28

- Source: [Papertable Harness 13 卡持续执行计划](../sources/INPUT-20260728-002.md)
- Branch: `governance/harness-orchestration-v2`
- Integration target: `feat/readonly-note-harness-alpha`
- Status: implementation complete; waiting for ADR user gate

## Changes

- Main lane fixed as serial; TASK-012 is the only conditional second lane.
- Added supervisor-owned acceptance, per-card logs, repair limits, explicit WenzMark settings, and Git pathspec rules.
- Moved Rust `readableIds` data-layer validation from TASK-012 to TASK-007.
- Reconciled TASK-001 with PR #2, merge SHA, remote CI, local regression, and WenzMark UI.
- Prepared the seven-ADR summary and consistency review without changing any ADR from `proposed`.

## Gate

After the user confirms ADR-001~007 as a group, update each ADR and DECISIONS index to `accepted`, run validation/CI, merge this governance PR, then create TASK-002.
