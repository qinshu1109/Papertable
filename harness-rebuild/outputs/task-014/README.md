# TASK-014 verdict/MemOS evidence

`contract-evidence.json` records the safe, content-free acceptance projection.
The checks exercised the real loopback MCP service through both Node and Rust.

- Web/Node: health, idempotent cube ensure, confirm/retry, project list,
  concept search, supersede, chain-tail projection, and cross-project isolation.
- Desktop/Rust: health, cube ensure, confirm/retry, supersede, chain-tail
  projection, and cross-project isolation through the same MCP protocol.
- Backup: the existing no-key snapshot verified the verdict Cube, then restored
  it into a temporary isolated base with exact-record equality. The temporary
  snapshot and restore were deleted after verification; no memory content or
  secret was copied into this repository.

Normal unit tests do not require MemOS. The opt-in real Rust check is:

```sh
/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml \
  live_mcp_contract_covers_health_idempotency_supersede_and_isolation \
  -- --ignored
```
