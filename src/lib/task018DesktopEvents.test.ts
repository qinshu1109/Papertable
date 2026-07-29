import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopInteractionRows } from "./task018DesktopEvents";

test("desktop event rows keep only authenticated verdict events", () => {
  const verdict = {
    id: "event-1",
    projectId: "project-1",
    sessionId: "session-1",
    type: "reroute-eligible",
    createdAt: 10,
    targetCardId: "card-1",
  };
  assert.deepEqual(
    parseDesktopInteractionRows([
      {
        id: verdict.id,
        projectId: verdict.projectId,
        createdAt: verdict.createdAt,
        doc: JSON.stringify(verdict),
      },
      {
        id: "ordinary",
        projectId: "project-1",
        createdAt: 11,
        doc: JSON.stringify({
          ...verdict,
          id: "ordinary",
          type: "card-dwell",
          createdAt: 11,
        }),
      },
    ]),
    [verdict],
  );
  assert.throws(
    () =>
      parseDesktopInteractionRows([
        {
          id: "wrong-row-id",
          projectId: verdict.projectId,
          createdAt: verdict.createdAt,
          doc: JSON.stringify(verdict),
        },
      ]),
    /与 doc 不一致/,
  );
});
