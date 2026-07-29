# TASK-020 verification

Captured: `2026-07-29T18:52:53+08:00`

## Functional acceptance

- All 13 previously synchronous variable-duration commands identified by this
  card are now `async` and execute their blocking HTTP or database work with
  `tauri::async_runtime::spawn_blocking`.
- The existing `llm_stream` blocking-pool and cancellation path is unchanged.
- LLM and MemOS use standard-library `OnceLock<ureq::Agent>` pools; no
  dependency, frontend invoke shape, timeout, retry, cancellation, tool
  schema, scope, readable ID, citation, or read-only boundary changed.
- Strict one-socket tests prove LLM connection reuse and MemOS transport reuse
  with a fresh MCP initialize/session for each logical call.
- The packaged isolated desktop remained interactive through a deterministic
  five-second response: card switching and native window dragging completed
  while the request was live, and the maximum 50 ms heartbeat gap was 53 ms
  against the 250 ms limit.

## Final gates

```text
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
PASS

cargo test ... llm::tests::consecutive_requests_reuse_the_shared_http_connection -- --exact
PASS — 1 passed

cargo test ... memos::tests::pooled_transport_keeps_each_mcp_call_on_a_fresh_session -- --exact
PASS — 1 passed

cargo test --manifest-path src-tauri/Cargo.toml
PASS — 99 passed, 0 failed, 1 ignored (opt-in live MemOS)

cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
PASS

pnpm verify
PASS — typecheck, ESLint, Prettier, 262 Node/TypeScript tests,
       99 Rust tests + 1 opt-in ignored, production web build

pnpm test:e2e
PASS — 41/41 in 59.4s

pnpm build:desktop
PASS

git diff --check
PASS

TASK020_PROVIDER_PORT=18889 PAPERTABLE_FAKE_LLM_DELAY_MS=0 node \
  harness-rebuild/outputs/task-020/delayed-openai-provider.mjs
curl POST /v1/chat/completions
PASS — deterministic answer returned; one request observed
```

The first two `pnpm verify` attempts were intentionally retained in the task
log: one found undeclared Node globals in the QA fixture, and one found four
unformatted evidence files. Both artifact-only issues were fixed before the
complete successful rerun above.

## Evidence index

- `blocking-command-inventory.md` — moved commands and frozen exclusions.
- `connection-pool-verification.md` — strict transport/session tests plus the
  packaged-desktop socket observation.
- `desktop-5s-responsiveness.md` — isolated desktop actions, heartbeat, and
  TASK-019 comparison.
- `post-implementation-5s.json` — exact q1-q5 Store timing records.
- `delayed-openai-provider.mjs` and `tauri.qa.conf.json` — reproducible local
  fixture and isolated desktop configuration.
