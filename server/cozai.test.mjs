import assert from "node:assert/strict";
import test from "node:test";
import {
  extractDelta,
  extractMessage,
  extractToolCallDeltas,
  extractToolCalls,
  friendlyProviderError,
  relayOpenAiStream,
} from "./cozai.mjs";
import { fakeCompletion, fakeToolCalls } from "./fake-provider.mjs";

/** 把若干条上游 SSE 帧喂给中继，返回它写出的全部文本。 */
async function relay(frames) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames)
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
        );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const chunks = [];
  await relayOpenAiStream({
    upstream: new Response(body, { status: 200 }),
    write: (chunk) => chunks.push(new TextDecoder().decode(chunk)),
  });
  return chunks.join("");
}

const deltaFrame = (delta) => ({ choices: [{ delta }] });

test("provider errors are mapped to readable Chinese messages", () => {
  assert.match(friendlyProviderError(401), /密钥/);
  assert.match(friendlyProviderError(429), /限流/);
  assert.match(friendlyProviderError(503), /暂时不可用/);
});

test("stream relay emits normalized token and done events", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const upstream = new Response(body, { status: 200 });
  const chunks = [];
  await relayOpenAiStream({
    upstream,
    write: (chunk) => chunks.push(new TextDecoder().decode(chunk)),
  });
  assert.match(chunks.join(""), /event: token/);
  assert.match(chunks.join(""), /你好/);
  assert.match(chunks.join(""), /event: done/);
});

test("reasoning deltas never reach the browser", async () => {
  const output = await relay([
    deltaFrame({ reasoning_content: "Since the user asked, I will plan." }),
    deltaFrame({ content: "量子退相干是指" }),
  ]);
  assert.ok(!output.includes("Since the user"), "推理文本泄漏到了 SSE 流里");
  assert.ok(!output.includes("I will plan"));
  assert.doesNotMatch(output, /event: reasoning/);
  assert.doesNotMatch(output, /"chars":34/);
  assert.match(output, /量子退相干是指/);
});

test("content after a reasoning delta stays subject to the output gate", async () => {
  const output = await relay([
    deltaFrame({ reasoning: "draft" }),
    deltaFrame({ content: "正文" }),
  ]);
  assert.match(output, /"channel":"unknown"/);
});

test("content without any reasoning delta stays unlabelled", async () => {
  const output = await relay([deltaFrame({ content: "正文" })]);
  assert.match(output, /"channel":"unknown"/);
});

test("a reasoning-only response still reports no displayable text", async () => {
  const output = await relay([deltaFrame({ reasoning_content: "draft only" })]);
  assert.match(output, /没有返回可显示的文本/);
  assert.ok(!output.includes("draft only"));
});

test("extractDelta separates the two fields, extractMessage keeps content only", () => {
  assert.deepEqual(
    extractDelta(deltaFrame({ content: "正文", reasoning_content: "草稿" })),
    { content: "正文", reasoning: "草稿" },
  );
  assert.deepEqual(extractDelta({}), { content: "", reasoning: "" });
  assert.equal(
    extractMessage({
      choices: [{ message: { reasoning_content: "草稿", content: "正文" } }],
    }),
    "正文",
  );
});

test("tool call deltas are normalized and never mistaken for visible text", async () => {
  const frame = deltaFrame({
    reasoning_content: "private draft",
    tool_calls: [
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "search_notes", arguments: '{"query":"量子"}' },
      },
    ],
  });
  assert.deepEqual(extractToolCallDeltas(frame), [
    {
      index: 0,
      id: "call_1",
      name: "search_notes",
      arguments: '{"query":"量子"}',
    },
  ]);
  const output = await relay([frame]);
  assert.match(output, /event: tool-call-delta/);
  assert.match(output, /search_notes/);
  assert.doesNotMatch(output, /private draft/);
  assert.doesNotMatch(output, /没有返回可显示的文本/);
});

test("completed non-streaming tool calls normalize OpenAI fields", () => {
  assert.deepEqual(
    extractToolCalls({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_2",
                type: "function",
                function: {
                  name: "read_notes",
                  arguments: '{"chunkIds":["a"]}',
                },
              },
            ],
          },
        },
      ],
    }),
    [
      {
        id: "call_2",
        name: "read_notes",
        arguments: '{"chunkIds":["a"]}',
      },
    ],
  );
});

test("test-only provider is explicit and produces a streamable answer", () => {
  const answer = fakeCompletion({
    task: "chat",
    messages: [{ role: "user", content: "上下文隔离" }],
  });
  assert.match(answer, /本地验收用的流式回答/);
  assert.match(answer, /上下文隔离/);
});

test("test-only provider emits a deterministic tool request before a tool result", () => {
  const calls = fakeToolCalls({
    task: "chat",
    messages: [{ role: "user", content: "找量子笔记" }],
    tools: [
      {
        type: "function",
        function: { name: "search_notes", parameters: { type: "object" } },
      },
    ],
  });
  assert.deepEqual(calls, [
    {
      id: "fake-tool-call-1",
      name: "search_notes",
      arguments: '{"query":"找量子笔记","limit":3}',
    },
  ]);
});
