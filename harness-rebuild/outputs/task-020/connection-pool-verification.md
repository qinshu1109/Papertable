# TASK-020 connection pool verification

Captured: `2026-07-29T18:09:58+08:00`

## LLM

`llm.rs` now exposes one process-wide `OnceLock<ureq::Agent>`. The focused
test starts a loopback HTTP/1.1 server that accepts exactly one TCP socket and
serves two sequential responses on it. Both requests complete and the two
`agent()` references are pointer-identical.

```text
cargo test ... llm::tests::consecutive_requests_reuse_the_shared_http_connection
1 passed; 0 failed
```

Because the same `ureq::Agent` owns the host connection pool, the second
request avoids a new DNS lookup/TCP connection/TLS setup when the first
connection remains reusable. Per-request 15/45/90/120 second timeouts remain
on their original request builders.

## MemOS

`memos.rs` now exposes one process-wide `OnceLock<ureq::Agent>` while each
public verdict operation still creates a logical `McpClient::call` scope.
The focused fake MCP server accepts exactly one TCP socket for four requests:

```text
initialize(no session)
tools/call(session-a)
initialize(no session)
tools/call(session-b)
```

The test asserts the exact method/header sequence, distinct session IDs, and
pointer identity of the shared agent.

```text
cargo test ... memos::tests::pooled_transport_keeps_each_mcp_call_on_a_fresh_session
1 passed; 0 failed
```

Thus transport reuse does not turn the MCP session into shared state.

## Packaged desktop observation

The five-second provider also logged transport IDs while the isolated desktop
bundle ran. When calls were close enough to remain inside the fixture's
keep-alive window, health and generation calls reused the same socket:

```text
connection=9
request=9  socket=54858 stream=false
request=10 socket=54858 stream=false
request=11 socket=54858 stream=true
```

Later ordinary turns likewise showed a streaming request and the following
non-streaming request on one socket (for example requests `15/16`, `18/19`,
`21/22`, `24/25`, `27/28`, `30/31`, and `33/34`). New connections between
serial questions are expected because each five-second response plus UI
settling exceeded the Node fixture's five-second idle keep-alive timeout. The
strict one-socket Rust tests above are the deterministic pass/fail proof.
