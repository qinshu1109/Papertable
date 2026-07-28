import assert from "node:assert/strict";
import test from "node:test";
import {
  Agent,
  runAgentLoop,
  type AgentEvent,
} from "@earendil-works/pi-agent-core";
import { Type, type Message } from "@earendil-works/pi-ai";
import {
  createPapertablePiStream,
  PAPERTABLE_PI_MODEL,
  type RustProviderStream,
} from "./pi-rust-bridge";

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
});

const searchTool = {
  name: "search_notes",
  label: "Search notes",
  description: "Search the bound read-only note library.",
  parameters: Type.Object({ query: Type.String() }),
  async execute(_id: string, input: { query: string }) {
    return {
      content: [{ type: "text" as const, text: `hit:${input.query}` }],
      details: { hitCount: 1 },
    };
  },
};

function fullRoundRustStream(): {
  stream: RustProviderStream;
  calls: () => number;
} {
  let count = 0;
  const stream: RustProviderStream = async function* (input) {
    count += 1;
    if (count === 1) {
      assert.equal(input.tools?.[0]?.function.name, "search_notes");
      yield {
        type: "tool-call-delta",
        index: 0,
        id: "call-1",
        name: "search_notes",
        arguments: '{"query":"Pi',
      };
      yield {
        type: "tool-call-delta",
        index: 0,
        arguments: ' bridge"}',
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    const assistant = input.messages.find(
      (message) => message.role === "assistant" && message.toolCalls?.length,
    );
    const result = input.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "call-1",
    );
    assert.equal(assistant?.toolCalls?.[0]?.name, "search_notes");
    assert.match(result?.content ?? "", /hit:Pi bridge/);
    yield { type: "token", text: "桥接成功", channel: "unknown" };
    yield { type: "done", finishReason: "stop" };
  };
  return { stream, calls: () => count };
}

test("Pi executes one complete tool round over the Rust-shaped stream", async () => {
  const fake = fullRoundRustStream();
  const agent = new Agent({
    initialState: {
      model: PAPERTABLE_PI_MODEL,
      systemPrompt: "Use search_notes once.",
      tools: [searchTool],
    },
    streamFn: createPapertablePiStream(fake.stream),
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });

  await agent.prompt("Find Pi bridge");

  assert.equal(fake.calls(), 2);
  assert.equal(
    events.filter((event) => event.type === "tool_execution_end").length,
    1,
  );
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  assert.deepEqual(final?.content, [{ type: "text", text: "桥接成功" }]);
  assert.equal(agent.state.errorMessage, undefined);
});

test("abort reaches the Rust-shaped stream and becomes Pi aborted", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stream: RustProviderStream = async function* (input) {
    entered();
    await new Promise<void>((resolve) =>
      input.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    yield { type: "done" };
  };
  const agent = new Agent({
    initialState: { model: PAPERTABLE_PI_MODEL },
    streamFn: createPapertablePiStream(stream),
  });
  const run = agent.prompt("wait");
  await started;
  agent.abort();
  await run;

  assert.equal(agent.state.errorMessage, "Papertable Rust stream aborted");
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  assert.equal(final?.stopReason, "aborted");
});

test("retry and recovery remain an external policy using Agent.continue", async () => {
  let attempts = 0;
  const stream: RustProviderStream = async function* () {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    yield { type: "token", text: "recovered", channel: "unknown" };
    yield { type: "done", finishReason: "stop" };
  };
  const agent = new Agent({
    initialState: { model: PAPERTABLE_PI_MODEL },
    streamFn: createPapertablePiStream(stream),
  });

  await agent.prompt("retry me");
  assert.equal(agent.state.errorMessage, "transient");
  agent.state.messages = agent.state.messages.slice(0, -1);
  await agent.continue();

  assert.equal(attempts, 2);
  assert.equal(agent.state.errorMessage, undefined);
  const recovered = agent.state.messages.at(-1);
  assert.equal(recovered?.role, "assistant");
  assert.deepEqual(recovered.content, [{ type: "text", text: "recovered" }]);
});

test("low-level shouldStopAfterTurn callback stops after tool execution", async () => {
  const fake = fullRoundRustStream();
  const events: AgentEvent[] = [];
  const messages = await runAgentLoop(
    [user("Find Pi bridge")],
    {
      systemPrompt: "Use search_notes once.",
      messages: [],
      tools: [searchTool],
    },
    {
      model: PAPERTABLE_PI_MODEL,
      convertToLlm: (input) => input as Message[],
      shouldStopAfterTurn: () => true,
    },
    (event) => {
      events.push(event);
    },
    undefined,
    createPapertablePiStream(fake.stream),
  );

  assert.equal(fake.calls(), 1);
  assert.equal(messages.at(-1)?.role, "toolResult");
  assert.equal(events.at(-1)?.type, "agent_end");
});
