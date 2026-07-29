# TASK-021 send preflight Promise graph

Baseline: verdict path `a57e880` with TASK-019 timing commit `5d4b467`.

## Before TASK-021

```text
send accepted
└─ create/update AI Turn in React state (synchronous)
   └─ await verdict context
      └─ freeze verdictTrace in Turn
         └─ await audited Turn persistence
            └─ await continuation audit (resume only)
               └─ build frozen card context
                  └─ await project library bindings
                     └─ await attachment list (new run only)
                        └─ await library metadata
                           └─ await Desktop live-scope check
                              └─ freeze host scope
                                 └─ capability admission/probe
                                    └─ claim continuation (resume only)
                                       └─ first Agent audit event
                                          └─ first Agent model request
```

## TASK-021 target

```text
send accepted
├─ create/update AI Turn + initial safe progress in React state (synchronous)
└─ start all independent reads in the same JavaScript turn
   ├─ verdict context ──> freeze verdictTrace ──> persist audited Turn ──┐
   ├─ project library bindings ────────────────────────────────────────┤
   ├─ attachment list (new run only; otherwise resolved []) ──────────┤
   └─ continuation audit (resume only; otherwise resolved null) ──────┤
                                                                       │
                         await first barrier <──────────────────────────┘
                                      │
                                      ├─ build context from frozen verdicts
                                      ├─ derive frozen library/attachment ids
                                      └─ start dependent, mutually independent reads
                                         ├─ library metadata
                                         └─ Desktop live-scope check
                                                   │
                                      await scope barrier
                                                   │
                                      freeze agentAudit.hostScope
                                                   │
                                      capability admission/probe
                                                   │
                                      claim continuation (resume only)
                                                   │
                                      first Agent audit event
                                                   │
                                      first Agent model request
```

## Required ordering

| Boundary                                | Must already be true                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| First preflight `await`                 | AI Turn and safe in-progress state are already in React state                                      |
| First Agent audit event                 | `verdictTrace` is frozen on the Turn and that Turn row is durably persisted                        |
| Capability probe or first Agent request | library IDs, attachment scope, continuation scope, and live Desktop availability result are frozen |
| `read_notes`                            | requested chunk IDs came from this run's frozen-scope `search_notes` results                       |
| Final answer release                    | citations still pass `controlledCitations`; compact `finalEvidence` retains every evidence field   |

No Promise carries a search query, tool argument, note body, model transcript, or hidden reasoning into UI progress.
