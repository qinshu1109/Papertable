import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "../types";
import {
  desktopAgentProgressText,
  desktopTurnsForDisplay,
  normalizeProjectName,
  PROJECT_NAME_LIMIT,
} from "./desktopUi";

test("desktop Agent progress exposes only safe counters", () => {
  const progress = {
    phase: "reading" as const,
    round: 2,
    searchCount: 3,
    hitCount: 8,
    readCount: 5,
    query: "SECRET_QUERY",
    toolArguments: '{"chunkIds":["SECRET_CHUNK"]}',
    transcript: "HIDDEN_REASONING",
    noteBody: "PRIVATE_NOTE_BODY",
  };
  const text = desktopAgentProgressText(progress);
  assert.equal(
    text,
    "正在阅读 · 第 2 轮 · 已检索 3 次 · 命中 8 段 · 已读 5 段",
  );
  assert.doesNotMatch(
    text,
    /SECRET_QUERY|SECRET_CHUNK|HIDDEN_REASONING|PRIVATE_NOTE_BODY/,
  );
});

test("desktop project names normalize whitespace without inventing a name", () => {
  assert.equal(normalizeProjectName("  小红书   起号  "), "小红书 起号");
  assert.equal(normalizeProjectName("   "), "");
  assert.equal(PROJECT_NAME_LIMIT, 60);
});

test("desktop retry replaces the failed attempt while retaining it in storage", () => {
  const turns: Turn[] = [
    {
      id: "question",
      role: "user",
      content: "绑定的笔记",
      createdAt: 1,
      status: "complete",
    },
    {
      id: "failed",
      role: "ai",
      content: "",
      createdAt: 2,
      status: "error",
      error: "连接意外中断，请重试。",
    },
    {
      id: "retry",
      role: "ai",
      content: "正在重试",
      createdAt: 3,
      status: "streaming",
    },
  ];

  assert.deepEqual(
    desktopTurnsForDisplay(turns).map((turn) => turn.id),
    ["question", "retry"],
  );
  assert.equal(turns[1]?.id, "failed", "the persisted audit row is untouched");
});

test("desktop display orders a same-millisecond user turn before its answer", () => {
  const turns: Turn[] = [
    { id: "old-user", role: "user", content: "一", createdAt: 1 },
    { id: "old-ai", role: "ai", content: "答一", createdAt: 2 },
    { id: "new-ai", role: "ai", content: "答二", createdAt: 3 },
    { id: "new-user", role: "user", content: "二", createdAt: 3 },
  ];

  assert.deepEqual(
    desktopTurnsForDisplay(turns).map((turn) => turn.id),
    ["old-user", "old-ai", "new-user", "new-ai"],
  );
});
