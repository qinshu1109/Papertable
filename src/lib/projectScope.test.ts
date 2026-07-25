import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_CARDS, DEMO_EDGES } from "../data/demo";
import { preferredProjectCard, scopeProject } from "./projectScope";

test("project scoping never leaks cards or edges from another project", () => {
  const graph = scopeProject(DEMO_CARDS, DEMO_EDGES, "p-agent");

  assert.equal(graph.cards.length, 1);
  assert.equal(graph.cards[0]?.id, "c-agent-root");
  assert.deepEqual(graph.edges, []);
});

test("project scoping restores the last valid card, then falls back safely", () => {
  assert.equal(
    preferredProjectCard(DEMO_CARDS, "p-quantum", "c-wave")?.id,
    "c-wave",
  );
  assert.equal(
    preferredProjectCard(DEMO_CARDS, "p-agent", "c-wave")?.id,
    "c-agent-root",
  );
});
