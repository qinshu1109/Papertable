import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderError,
  getProviderHealth,
  normalizeProviderCapabilityResult,
  providerErrorMessage,
  streamModel,
} from "./http";

function withFetch(
  replacement: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("web health check maps empty 500 replies without exposing JSON parser details", async () => {
  await withFetch(
    async () => new Response("", { status: 500 }),
    async () => {
      await assert.rejects(
        () => getProviderHealth(),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.code, "service-unavailable");
          assert.doesNotMatch(error.message, /json|unexpected|response/i);
          return true;
        },
      );
    },
  );
});

test("web stream consumes the typed timeout error instead of a raw SSE detail", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'event: error\ndata: {"message":"http://127.0.0.1 EOF","code":"timeout"}\n\n',
        ),
      );
      controller.close();
    },
  });
  await withFetch(
    async () => new Response(body, { status: 200 }),
    async () => {
      const iterator = streamModel({
        task: "chat",
        messages: [{ role: "user", content: "测试" }],
        signal: new AbortController().signal,
      });
      await assert.rejects(
        () => iterator.next(),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.code, "timeout");
          assert.equal(error.message, "请求超时，请重试。");
          return true;
        },
      );
    },
  );
});

test("web stream treats a closed stream without done as a safe disconnect", async () => {
  await withFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.close(),
        }),
        { status: 200 },
      ),
    async () => {
      const iterator = streamModel({
        task: "chat",
        messages: [{ role: "user", content: "测试" }],
        signal: new AbortController().signal,
      });
      await assert.rejects(
        () => iterator.next(),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.code, "disconnected");
          assert.equal(error.message, "连接意外中断，请重试。");
          return true;
        },
      );
    },
  );
});

test("provider empty-response uses the TASK-002 provider-empty copy", () => {
  assert.equal(
    providerErrorMessage("empty-response"),
    "模型服务没有返回可处理的内容，请重试。",
  );
});

test("web stream preserves normalized provider usage on done", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'event: done\ndata: {"stopped":false,"finishReason":"stop","usage":{"inputTokens":5,"outputTokens":2,"totalTokens":7}}\n\n',
        ),
      );
      controller.close();
    },
  });
  await withFetch(
    async () => new Response(body, { status: 200 }),
    async () => {
      const received = [];
      for await (const event of streamModel({
        task: "agent",
        messages: [{ role: "user", content: "测试" }],
        signal: new AbortController().signal,
      }))
        received.push(event);
      assert.deepEqual(received, [
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        },
      ]);
    },
  );
});

test("web and Tauri probes share one fail-closed public capability normalizer", () => {
  const wire = {
    mode: "native-tools",
    protocolAdapterVersion: "openai-native-tools-v1",
    gatewayResponseShape: "openai-chat-completions-v1",
    toolCallEmission: { status: "passed" },
    toolResultAcceptance: { status: "passed" },
    streamingToolCallDelta: { status: "passed" },
    testedAt: "2026-07-28T00:00:00.000Z",
  };
  const web = normalizeProviderCapabilityResult(wire);
  const tauri = normalizeProviderCapabilityResult(structuredClone(wire));
  assert.deepEqual(tauri, web);
  assert.equal(web.mode, "native-tools");
  assert.equal(
    normalizeProviderCapabilityResult({ ...wire, mode: "unavailable" }).mode,
    "unavailable",
  );
  assert.equal(
    normalizeProviderCapabilityResult({ ...wire, testedAt: undefined }).mode,
    "unavailable",
  );

  const malformed = normalizeProviderCapabilityResult({
    ...wire,
    streamingToolCallDelta: undefined,
  });
  assert.equal(malformed.mode, "unavailable");
  assert.equal(malformed.streamingToolCallDelta.status, "failed");
});
