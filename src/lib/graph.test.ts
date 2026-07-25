import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_CARDS, DEMO_EDGES } from "../data/demo";
import { layoutGraph, pathToRoot, subtreeIds } from "./graph";
import { scopeProject } from "./projectScope";

test("graph helper returns a stable root-to-current path", () => {
  assert.deepEqual(pathToRoot(DEMO_EDGES, "c-hilbert"), [
    "c-root",
    "c-decoherence",
    "c-wave",
    "c-hilbert",
  ]);
});

test("graph layout hides only the collapsed subtree", () => {
  const project = scopeProject(DEMO_CARDS, DEMO_EDGES, "p-quantum");
  const graph = layoutGraph(
    project.cards,
    project.edges,
    new Set(["c-decoherence"]),
  );

  assert.deepEqual(graph.hidden, new Set(["c-wave", "c-hilbert"]));
  assert.equal(graph.nodes.has("c-root"), true);
  assert.equal(graph.nodes.has("c-cryo"), true);
});

test("graph helper collects a card and all descendants", () => {
  assert.deepEqual(subtreeIds(DEMO_EDGES, "c-decoherence"), [
    "c-decoherence",
    "c-wave",
    "c-hilbert",
  ]);
});
