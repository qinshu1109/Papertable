# TASK-013 final acceptance gate

## Executable lanes

- `pnpm acceptance:task-013` — replays all 32 schema-v1 fixtures from
  TASK-004 through TASK-012, runs six deterministic production-loop cases,
  and checks the local three-stage provider contract.
- `pnpm acceptance:task-013:real` — starts the existing local provider host,
  probes the configured model, and runs the safe synthetic real/injected
  matrix.
- `pnpm acceptance:task-013:all` — runs both lanes and emits one JSON report.

The runner never prints or persists an API key, model response, synthetic note
body, hidden reasoning, absolute source path, or provider payload. It reports
only provider identity/configuration availability, structural transitions,
terminal states, and the six accepted criteria.

## Replay behavior

`golden-manifest.json` inventories every JSON fixture in
`outputs/task-004/` through `outputs/task-012/`. The runner discovers the
directories independently, requires schema v1, and compares a six-criterion
semantic projection. Answer/content wording is reduced to presence, so wording
changes do not fail replay; terminal, tool, persistence, authority, duplicate,
or fallback changes do.

## Fixed cases

- Exhaustion plus successful synthesis:
  `partial/rounds_exhausted`, with read evidence and terminal audit retained.
- Exhaustion plus failed final-synthesis repair:
  `failed/protocol_error`, with read evidence and terminal audit retained and
  no visible answer.

## Real lane

The configured `claude-opus-5` lane passed all three native-tool handshake
stages and all six matrix criteria. Natural convergence, budget exhaustion,
no-progress lure, and attachment citation used external model calls with
in-memory synthetic notes. The two failure rows used deterministic fault
injection after the real capability was admitted; they are marked `injected`
in `acceptance-matrix.json` rather than presented as organic model failures.

The model avoided the no-progress lure after one empty search, so that row
accepted `completed/none` with zero duplicate events. The deterministic
runtime row separately forces occurrences 2 and 3 and verifies the host stops
at `refused/insufficient_evidence`.
