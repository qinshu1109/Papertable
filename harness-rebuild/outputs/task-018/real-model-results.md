# Real flagship-model A/B

Not run.

TASK-018 requires ten old questions selected by the user and a recurrence rule
frozen before any response is generated. Neither input exists in the workspace
or the verdict Cube. Running the provided placeholders would violate the card's
ban on simulated evidence.

The configured `claude-opus-5` lane remains available (TASK-013 previously
passed its real-provider admission and matrix). Run `pnpm acceptance:task-018`
with the private ten-case file once the user freezes it; the runner records both
responses with `recurrence: null` and leaves judgment to the supervisor.
