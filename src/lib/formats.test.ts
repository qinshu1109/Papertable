import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { formatAdapters, projectBundle } from "./formats";
import type { PortableProject } from "../types";

const project = (): PortableProject => ({
  version: 1,
  project: { id: "p", name: "格式测试", pinned: false, updatedAt: 1 },
  cards: [
    {
      id: "root",
      projectId: "p",
      title: "根卡",
      favorite: false,
      unread: false,
      concepts: [],
      createdAt: 1,
      turns: [
        {
          id: "u",
          role: "user",
          content: "问题",
          createdAt: 1,
          status: "complete",
        },
      ],
    },
    {
      id: "child",
      projectId: "p",
      title: "子卡",
      favorite: false,
      unread: false,
      concepts: [],
      createdAt: 2,
      turns: [
        {
          id: "a",
          role: "ai",
          content: "答案",
          createdAt: 2,
          status: "complete",
        },
      ],
    },
  ],
  edges: [
    {
      id: "edge",
      type: "child",
      sourceCardId: "root",
      targetCardId: "child",
      contextPolicy: "topic-and-selection",
      contextSnapshotId: "snapshot",
    },
  ],
  anchors: [{ id: "anchor", cardId: "root", exact: "问题", text: "问题" }],
  snapshots: [
    {
      id: "snapshot",
      edgeId: "edge",
      createdAt: 2,
      sourceTitle: "根卡",
      sourceText: "问题",
    },
  ],
  references: [],
});

test("native project package preserves graph, snapshots and cards", async () => {
  const artifact = await projectBundle(project());
  const bytes = await artifact.blob.arrayBuffer();
  const zip = await JSZip.loadAsync(bytes);
  assert.ok(
    Object.keys(zip.files).some((name) => name.endsWith("manifest.json")),
  );
  assert.ok(Object.keys(zip.files).some((name) => name.includes("assets/")));
  const file = new File([bytes], artifact.filename, {
    type: "application/zip",
  });
  const restored = await formatAdapters.bundle.import({
    format: "bundle",
    files: [file],
  });
  assert.equal(restored.cards.length, 2);
  assert.equal(restored.edges[0].contextSnapshotId, "snapshot");
  assert.equal(restored.snapshots[0].sourceText, "问题");
});
