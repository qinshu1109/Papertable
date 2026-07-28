# TASK-001 — Pi bridge spike report

Date: 2026-07-28  
Branch: `task/TASK-001-pi-bridge-spike`  
Package tested: `@earendil-works/pi-agent-core@0.82.1` with `@earendil-works/pi-ai@0.82.1`

Both packages are pinned only in this output directory's isolated spike manifest and lockfile. Papertable's production root manifest and lockfile do not carry them.

## Result

The dependency can be browser-bundled above Papertable's existing Tauri/Rust provider without exposing the API key, and a simulated Rust-shaped stream completes a Pi tool round. The real configured flagship path is not reliable enough to count as a completed production round: it accepted tool calls/results, but repeated `search_notes` or returned no final text, and capability results changed between consecutive runs.

**Final recommendation: port the useful Pi loop patterns; do not introduce Pi as a Papertable runtime dependency.**

## Four spike questions

### 1. Can the existing Rust channel drive one flagship tool round?

**Mechanically yes; reliably to final text, no.**

- The spike imports the existing Tauri `streamModel` and adapts it to Pi `StreamFn`. A production browser bundle succeeds without `provider.json`, `apiKey`, Node, shell, `createReadOnlyTools`, or `pi-coding-agent` markers.
- The standalone Rust probe compiles the repository's actual `src-tauri/src/llm.rs`, verifies the existing provider file is `0600`, and never returns the key to TypeScript or output.
- The real provider returned a forced `search_notes` call. `llm.rs` accepted the matching assistant tool call and tool-result message. One capability run reported `native-tools`, streaming tool calls, and accepted tool results.
- The custom round did not reliably terminate. No run produced final text; one second turn emitted `search_notes` again despite `tool_choice: "none"`. A later capability run flipped to `two-stage`.

Conclusion: the Rust ownership/security boundary is compatible with Pi, but neither Pi nor this adapter repairs the current upstream protocol/termination instability. Evidence: `rust-probe-evidence.md`.

### 2. Tool-call and streaming conversion cost

**Medium-to-high, not a thin alias.**

The runnable adapter is 316 lines, plus 177 lines of protocol tests. It must:

- convert Pi system/user/assistant/tool-result messages to Papertable's four Rust roles;
- convert Typebox tool schemas to the OpenAI-compatible function shape accepted by `llm.rs`;
- rebuild Pi's `text_start/delta/end` and `toolcall_start/delta/end` lifecycle from Papertable token/tool-delta events;
- accumulate fragmented tool JSON and attach a complete `partial: AssistantMessage` snapshot to every Pi delta;
- map Rust finish reasons and failures into Pi terminal `done`/`error` messages without throwing.

The protocols still do not match completely:

- Rust emits no usage/cost data, so the spike must use zeros.
- Rust intentionally drops reasoning; Pi thinking events therefore cannot be populated.
- The current TypeScript Tauri wrapper drops Rust's `stopped` boolean; abort classification relies on the shared `AbortSignal`.
- Papertable's Rust whitelist is domain-specific (`search_notes`, `read_notes`), while Pi tools are open-ended.

The final browser artifact is small because tree-shaking works: 28,186 bytes unminified, 7.03 kB gzip. Installation cost is larger: the Pi dependency graph adds about 90 transitive packages. The self-contained spike package, including its test/build tools, resolves 111 packages into an ignored local install and has a 1,801-line isolated lockfile.

### 3. Can abort, retry, and recovery use Pi's external termination hooks?

**Abort and graceful stop fit; retry/recovery remain application policy.**

- Abort works end to end in the adapter test: `Agent.abort()` aborts Pi's signal; the production binding passes it to `streamModel`; `streamModel` invokes `llm_cancel_stream`; Rust sets its `AtomicBool`.
- The low-level `shouldStopAfterTurn` callback successfully stops after a tool batch and before another provider call.
- A transient failure can be retried by an external controller, but the tested recovery requires removing the terminal failed assistant message and calling `Agent.continue()`. Pi's `Agent` does not make this a complete durable recovery protocol.
- Pi core has no Papertable budget, no-progress, repeated-tool, or protocol-repair policy. The real probe's repeated `search_notes` would continue unless Papertable adds those controls.

Conclusion: Pi exposes useful hooks, but Papertable must still own stop reasons, retry classification, persisted checkpoints, and recovery semantics.

### 4. Is the code simpler after introducing Pi?

**For Papertable's current split Rust/TypeScript architecture, it is more indirect.**

Pi removes the need to hand-write a basic tool loop, but it does not replace the Rust provider, Papertable's validation/security boundary, trace persistence, budgets, or protocol repair. It adds:

- a second message model and a second stream-event model;
- a non-trivial bridge with synthetic usage/terminal fields;
- a broad provider SDK dependency graph even though Papertable must not use those providers directly;
- recovery behavior that still needs Papertable-specific transcript and persistence rules.

The low-level Pi loop is useful reference code. The full dependency does not eliminate enough Papertable code to pay for the extra boundary.

## Dependency vs pattern-port decision

Choose **pattern port** for TASK-004:

1. Port the explicit loop lifecycle: agent/turn/message/tool start-update-end events.
2. Port AbortSignal propagation and callback points equivalent to `beforeToolCall`, `afterToolCall`, `shouldStopAfterTurn`, and `prepareNextTurn`.
3. Keep Papertable's Rust provider and tool whitelist as the only model/security boundary.
4. Add Papertable-owned budgets, repeated-call/no-progress detection, explicit result×reason termination, and persisted recovery checkpoints.
5. Do not port `AgentHarness`, provider SDKs, session storage, compaction, coding-agent tools, shell, or file-system environments.

Reconsider the dependency only if the Rust channel later emits a Pi-complete terminal protocol (usage, abort reason, stable tool completion) and a measured deletion shows the bridge plus custom policies remove more code than they add.

## Verification

Passed:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir harness-rebuild/outputs/task-001 install \
  --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm --dir harness-rebuild/outputs/task-001 run typecheck
pnpm exec eslint harness-rebuild/outputs/task-001/*.ts
pnpm --dir harness-rebuild/outputs/task-001 test
/Users/qinshu/.cargo/bin/cargo check \
  --manifest-path harness-rebuild/outputs/task-001/rust-channel-probe/Cargo.toml --quiet
pnpm --dir harness-rebuild/outputs/task-001 run bundle
rg -n 'node:|child_process|createReadOnlyTools|pi-coding-agent|apiKey|provider\.json' \
  harness-rebuild/outputs/task-001/dist/pi-rust-bridge.js
```

Results:

- four adapter tests passed;
- the final explicit TypeScript check, repository typecheck, and ESLint passed;
- the Rust probe compiled against the real `llm.rs`;
- Vite transformed 702 modules and emitted a 28,186-byte ESM bundle (7.03 kB gzip);
- the forbidden-marker search returned no matches.
- the production root manifest, lockfile, and workspace build allowlist remain unchanged by the spike.

Real-provider probe: compiled and ran, but exited non-zero because the custom round did not produce final text. This is the spike finding, not a compile/test failure. Sanitized evidence is preserved in `rust-probe-evidence.md`.

TASK-001 verify criterion passes: this report exists, all four questions have runnable-code conclusions, and the dependency-vs-pattern-port recommendation is explicit.

## Unresolved risks

- The current flagship/provider capability result changed between consecutive runs (`native-tools` then `two-stage`).
- The upstream ignored or failed to honor `tool_choice: "none"` in one observed post-tool turn.
- The Rust stream lacks usage and explicit retry/recovery metadata needed by the target state machine.
- The Tauri TypeScript wrapper discards Rust's `stopped` field.
- Pi core itself has no Papertable-specific budget or repeated-tool/no-progress guard.
- `@earendil-works/pi-ai` brings provider SDKs that Papertable does not need; tree-shaking limits the browser bundle but not install/supply-chain surface.
- The isolated package is installed with lifecycle scripts disabled; Papertable's root build allowlist is unchanged.
- The Rust probe's generated `target/` directory is ignored by its local `.gitignore`; it remains on disk because this task forbids deleting files.
