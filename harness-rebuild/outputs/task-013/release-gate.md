# TASK-013 release gate

## Gate definition

The final gate asserts exactly:

1. correct tool calls;
2. correct terminal state;
3. persisted evidence;
4. no unauthorized reads;
5. no unhandled duplicate calls;
6. no two-stage behavior on protocol failure.

It does not compare answer wording.

## Objective evidence

- Golden replay: 32/32 schema-v1 fixtures passed.
- Deterministic runtime matrix: 6/6 rows passed all six criteria.
- Local provider contract: tool-call emission, tool-result acceptance, and
  streaming tool-call delta all passed.
- Configured real provider: `claude-opus-5` on `cozai.net`; all three
  admission stages and 6/6 matrix rows passed.
- Mandatory fixed success:
  `partial/rounds_exhausted`.
- Mandatory fixed failure:
  `failed/protocol_error`, evidence retained, no answer emitted.

The implementation is a candidate pass. TASK-013 remains `in_progress` until
the supervisor independently accepts it.
