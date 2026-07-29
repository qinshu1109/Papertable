import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ProviderErrorCode, ProviderStreamEvent } from "../types";
import {
  assembleToolProtocol,
  normalizeToolProtocolText,
  PROTOCOL_RETRY_CLASSIFICATION,
  visibleProtocolLeak,
  visibleProtocolPrefix,
} from "./agentProtocolRepair";

test("retry classification table covers every provider row with bounded policy", () => {
  const rows: Array<[ProviderErrorCode, string, number, readonly number[]]> = [
    ["unauthorized", "fail", 0, []],
    ["rate-limited", "retry-with-backoff", 2, [250, 750]],
    ["service-unavailable", "retry", 2, [0, 0]],
    ["upstream", "retry", 2, [0, 0]],
    ["disconnected", "retry", 2, [0, 0]],
    ["timeout", "retry", 2, [0, 0]],
    ["empty-response", "retry", 2, [0, 0]],
    ["invalid-response", "repair-protocol", 0, []],
  ];
  assert.deepEqual(Object.keys(PROTOCOL_RETRY_CLASSIFICATION).sort(), [
    "disconnected",
    "empty-response",
    "invalid-response",
    "rate-limited",
    "service-unavailable",
    "timeout",
    "unauthorized",
    "upstream",
  ]);
  for (const [code, action, maxRetries, backoffMs] of rows)
    assert.deepEqual(PROTOCOL_RETRY_CLASSIFICATION[code], {
      action,
      maxRetries,
      backoffMs,
    });
});

test("TASK-013 retry classification fixture stays synchronized", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../harness-rebuild/outputs/task-007/retry-classification.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    rows: Array<{
      code: ProviderErrorCode;
      action: string;
      maxRetries: number;
      backoffMs: number[];
    }>;
  };
  for (const row of fixture.rows)
    assert.deepEqual(PROTOCOL_RETRY_CLASSIFICATION[row.code], {
      action: row.action,
      maxRetries: row.maxRetries,
      backoffMs: row.backoffMs,
    });
});

test("fragmented arguments are reassembled losslessly in provider order", () => {
  const fragments: ProviderStreamEvent[] = [
    {
      type: "tool-call-delta",
      index: 0,
      id: "call-1",
      name: "search_notes",
      arguments: '{"query":"原',
    },
    {
      type: "tool-call-delta",
      index: 0,
      arguments: '样 值","limit":',
    },
    { type: "tool-call-delta", index: 0, arguments: "4}" },
  ];
  assert.deepEqual(assembleToolProtocol(fragments), {
    calls: [
      {
        id: "call-1",
        name: "search_notes",
        arguments: '{"query":"原样 值","limit":4}',
      },
    ],
    deterministicActions: ["工具参数按流式片段到达顺序无损重组"],
  });
});

test("NFKC and zero-width cleanup can make an otherwise complete call legal", () => {
  const assembled = assembleToolProtocol([
    {
      type: "tool-call-delta",
      index: 0,
      id: "call-1",
      name: "ｓｅａｒｃｈ＿ｎｏｔｅｓ\u200b",
      arguments: '｛\u200b"query"："证据"｝',
    },
  ]);
  assert.deepEqual(assembled.calls, [
    {
      id: "call-1",
      name: "search_notes",
      arguments: '{"query":"证据"}',
    },
  ]);
  assert.ok(assembled.deterministicActions.some((item) => /NFKC/.test(item)));
  assert.ok(assembled.deterministicActions.some((item) => /零宽/.test(item)));
});

test("full-width protocol tags normalize for detection but are never stripped into a call", () => {
  const normalized = normalizeToolProtocolText(
    '＜tool_call＞{"query":"证据"}＜/tool_call＞',
  );
  assert.equal(normalized.containsProtocolTag, true);
  const assembled = assembleToolProtocol([
    {
      type: "tool-call-delta",
      index: 0,
      id: "call-1",
      name: "search_notes",
      arguments: '＜tool_call＞{"query":"证据"}＜/tool_call＞',
    },
  ]);
  assert.deepEqual(assembled.calls, []);
  assert.match(assembled.issue ?? "", /协议标签/);
  assert.equal(
    visibleProtocolLeak([
      {
        type: "token",
        text: "＜tool_call＞",
        channel: "final",
      },
    ]),
    true,
  );
});

test("split visible protocol prefixes remain blocked at the response boundary", () => {
  assert.equal(visibleProtocolPrefix("<too"), true);
  assert.equal(visibleProtocolPrefix("</ function_ca"), true);
  assert.equal(visibleProtocolPrefix("<table"), false);
  assert.equal(
    visibleProtocolLeak([
      { type: "token", text: "正文<tool_", channel: "unknown" },
    ]),
    true,
  );
});

test("ambiguous calls never guess a name, invent arguments, or append braces", () => {
  const emptyName = assembleToolProtocol([
    {
      type: "tool-call-delta",
      index: 0,
      id: "call-empty",
      name: "",
      arguments: '{"query":"证据"}',
    },
  ]);
  assert.deepEqual(emptyName.calls, []);
  assert.match(emptyName.issue ?? "", /工具名为空/);

  const missingArguments = assembleToolProtocol([
    {
      type: "tool-call-delta",
      index: 0,
      id: "call-missing",
      name: "search_notes",
    },
  ]);
  assert.deepEqual(missingArguments.calls, []);
  assert.match(missingArguments.issue ?? "", /缺少完整参数/);

  const truncated = assembleToolProtocol([
    {
      type: "tool-call-delta",
      index: 0,
      id: "call-truncated",
      name: "search_notes",
      arguments: '{"query":"证据"',
    },
  ]);
  assert.deepEqual(truncated.calls, []);
  assert.match(truncated.issue ?? "", /不是完整的 JSON 对象/);
  assert.equal(
    truncated.deterministicActions.some((item) =>
      /补|append|brace/i.test(item),
    ),
    false,
  );
});
