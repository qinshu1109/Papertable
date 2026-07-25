import assert from "node:assert/strict";
import test from "node:test";
import { friendlyProviderError, relayOpenAiStream } from "./cozai.mjs";
import { fakeCompletion } from "./fake-provider.mjs";

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

test("test-only provider is explicit and produces a streamable answer", () => {
  const answer = fakeCompletion({
    task: "chat",
    messages: [{ role: "user", content: "上下文隔离" }],
  });
  assert.match(answer, /本地验收用的流式回答/);
  assert.match(answer, /上下文隔离/);
});
