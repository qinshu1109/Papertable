# TASK-020 blocking command inventory

Captured: `2026-07-29T18:05:39+08:00`

Integrated base: `d3b8951` (`a57e880` verdict chain plus TASK-019 timing).

## Must run on Tauri's blocking pool

| Command                     | Blocking work                                               | Call chain                                                                                 | Semantics that must stay fixed                                             |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `provider_health`           | authenticated `ureq` POST, 15 s timeout                     | `provider/tauri.ts → lib.rs → llm::health`                                                 | same safe `ProviderHealth`, timeout and error copy                         |
| `llm_generate`              | non-stream `ureq` POST, 90 s timeout                        | title/concept callers → `provider/tauri.ts → lib.rs → llm::generate`                       | text-only result and validation                                            |
| `llm_complete`              | non-stream `ureq` POST, 90 s timeout                        | Harness → `provider/tauri.ts → lib.rs → llm::complete`                                     | native tool calls, usage and typed errors                                  |
| `provider_probe_capability` | three sequential `ureq` probe requests, 45/90 s timeouts    | capability gate → `provider/tauri.ts → lib.rs → llm::probe_capability`                     | three-stage fail-closed admission                                          |
| `llm_stream`                | streaming `ureq` POST/read, 120 s timeout                   | Harness/chat → `provider/tauri.ts → lib.rs → llm::stream`                                  | already uses `spawn_blocking`; cancellation remains the shared atomic flag |
| `verdict_health`            | MCP initialize + `health`                                   | `verdicts/tauri.ts → lib.rs → memos`                                                       | explicit unavailable DTO                                                   |
| `verdict_ensure_cube`       | MCP initialize/call, possible create and list retry         | same                                                                                       | idempotent ensure                                                          |
| `verdict_list`              | MCP initialize + bounded FTS search                         | same                                                                                       | project isolation and chain-tail projection                                |
| `verdict_confirm`           | MCP calls under the single writer lock                      | same                                                                                       | validation, idempotency and confirmed-only write                           |
| `verdict_supersede`         | MCP get/search/add/get under the writer lock                | same                                                                                       | append-only supersede; no delete/update path                               |
| `note_library_search`       | variable SQLite FTS/ranking plus persisted run grants       | `agent.ts → notes/scoped.ts → notes/tauri.ts → lib.rs → notes::search_project_for_run`     | Rust-frozen project scope and per-run grant transaction                    |
| `note_library_read`         | variable allowlist validation and chunk reads               | same                                                                                       | every ID must have been granted by this run's Rust search                  |
| `attachment_search`         | variable SQLite ranking plus separate attachment run grants | `agent.ts → notes/scoped.ts → attachments/tauri.ts → lib.rs → attachments::search_for_run` | frozen project/card scope and separate allowlist                           |
| `attachment_read`           | variable attachment allowlist validation and reads          | same                                                                                       | requested order, active run/project/card and searched IDs                  |

## Deliberately left synchronous

Short deterministic state/config commands, atomic cancellation, ordinary
workspace row operations, list/binding/scope metadata reads, citation
resolution, and explicit import/rebuild/export workflows are outside this
generation-path card. Changing them for symmetry would expand scope and could
alter ordering.

## Connection/session ownership

- `llm.rs`: one process-wide `OnceLock<ureq::Agent>` owns DNS/TCP/TLS pooling;
  every request keeps its existing per-call timeout and headers.
- `memos.rs`: one process-wide `OnceLock<ureq::Agent>` owns transport pooling.
  `McpClient::call` must still send an initialize request without a session,
  consume the newly returned `mcp-session-id`, and use that ID only for the
  immediately following tool call.
- A reused HTTP connection is transport state only; an MCP session is logical
  request state and must never be stored in the shared agent/client singleton.

## TASK-019 comparison fixture

- Frozen real-question set: `outputs/task-019/frozen-questions.json` q1–q5.
- Pre-implementation median:
  `preflightMs=1`, `firstVisibleMs=36516`, `totalMs=36516`.
- Deterministic delay control:
  `PAPERTABLE_FAKE_LLM_DELAY_MS=5000`.
