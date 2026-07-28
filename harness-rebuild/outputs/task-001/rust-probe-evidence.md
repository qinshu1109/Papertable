# TASK-001 real Rust-channel evidence

Date: 2026-07-28  
Provider configuration: existing `provider.json`, verified mode `0600`; API key was loaded only by `src-tauri/src/llm.rs` and was not printed or passed to TypeScript.

Command:

```sh
PAPERTABLE_PROVIDER_CONFIG='/Users/qinshu/Library/Application Support/com.papertable.app/provider.json' \
  /Users/qinshu/.cargo/bin/cargo run \
  --manifest-path harness-rebuild/outputs/task-001/rust-channel-probe/Cargo.toml \
  --quiet
```

Instrumented run A:

```json
{
  "apiKeyExposed": false,
  "capabilityMode": "native-tools",
  "capabilityToolResultAccepted": true,
  "customRoundRequestAccepted": true,
  "finalTextPresent": false,
  "firstTurnTool": "search_notes",
  "providerConfigMode": "owner-only-file",
  "providerFileModeChecked": true,
  "streamingToolCalls": true
}
```

Instrumented run B:

```json
{
  "apiKeyExposed": false,
  "capabilityMode": "two-stage",
  "capabilityToolResultAccepted": false,
  "customRoundRequestAccepted": true,
  "finalTextPresent": false,
  "finalToolNames": ["search_notes"],
  "firstTurnTool": "search_notes",
  "providerConfigMode": "owner-only-file",
  "providerFileModeChecked": true,
  "streamingToolCalls": false
}
```

Both custom runs received the first forced `search_notes` call and submitted a matching tool result through the existing Rust request normalizer. Neither produced final text. Run B showed the upstream model issuing `search_notes` again even though the second request set `tool_choice: "none"`.

This is evidence of transport compatibility and of current termination unreliability. It is not evidence that Pi caused the upstream behavior; the same `llm.rs` path exhibits it without Pi.
