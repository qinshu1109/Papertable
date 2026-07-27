import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function nextPort() {
  return 19_000 + Math.floor(Math.random() * 10_000);
}

async function waitForHealth(origin) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // 进程刚启动时端口还未监听。
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("本机设置服务未能启动");
}

test("本机设置端点保存安全配置且不回传密钥", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "papertable-config-"));
  const configPath = path.join(folder, ".env.local");
  const port = nextPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PAPERTABLE_PORT: String(port),
      PAPERTABLE_CONFIG_FILE: configPath,
      COZAI_API_KEY: "",
      PAPERTABLE_FAKE_LLM: "",
    },
    stdio: "ignore",
  });
  try {
    await waitForHealth(origin);
    const saved = await fetch(`${origin}/api/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({
        baseUrl: "https://example.test/v1/",
        model: "example-model",
        apiKey: "test-key-not-a-real-secret",
      }),
    });
    assert.equal(saved.status, 200);
    const safeConfig = await saved.json();
    assert.deepEqual(safeConfig, {
      baseUrl: "https://example.test/v1",
      model: "example-model",
      hasApiKey: true,
      message: "已保存本机配置。",
    });
    assert.doesNotMatch(
      JSON.stringify(safeConfig),
      /test-key-not-a-real-secret/,
    );
    assert.match(
      await readFile(configPath, "utf8"),
      /COZAI_API_KEY=test-key-not-a-real-secret/,
    );
    assert.equal((await stat(configPath)).mode & 0o077, 0);

    const rejected = await fetch(`${origin}/api/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({
        baseUrl: "http://example.test/v1",
        model: "example-model",
      }),
    });
    assert.equal(rejected.status, 400);

    const foreignOrigin = await fetch(`${origin}/api/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.example",
      },
      body: JSON.stringify({
        baseUrl: "https://example.test/v1",
        model: "example-model",
      }),
    });
    assert.equal(foreignOrigin.status, 403);
  } finally {
    child.kill();
    await rm(folder, { recursive: true, force: true });
  }
});

test("本机假模型覆盖受限工具协议和能力探测", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "papertable-tools-"));
  const port = nextPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PAPERTABLE_PORT: String(port),
      PAPERTABLE_CONFIG_FILE: path.join(folder, ".env.local"),
      PAPERTABLE_FAKE_LLM: "1",
    },
    stdio: "ignore",
  });
  const tool = {
    type: "function",
    function: {
      name: "search_notes",
      description: "仅检索当前项目已绑定的只读笔记。",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  };
  try {
    await waitForHealth(origin);
    const capabilities = await fetch(`${origin}/api/llm/capabilities`, {
      method: "POST",
    });
    assert.equal(capabilities.status, 200);
    const capabilityResult = await capabilities.json();
    assert.equal(capabilityResult.mode, "native-tools");
    assert.equal(capabilityResult.streamingToolCalls, true);
    assert.equal(capabilityResult.toolResultAccepted, true);
    assert.match(capabilityResult.testedAt, /^\d{4}-\d{2}-\d{2}T/);

    const completion = await fetch(`${origin}/api/llm/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "chat",
        messages: [{ role: "user", content: "查找只读资料" }],
        tools: [tool],
        toolChoice: { type: "function", function: { name: "search_notes" } },
      }),
    });
    assert.equal(completion.status, 200);
    const result = await completion.json();
    assert.equal(result.content, "");
    assert.equal(result.toolCalls?.[0]?.name, "search_notes");

    const stream = await fetch(`${origin}/api/llm/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "chat",
        messages: [{ role: "user", content: "查找只读资料" }],
        tools: [tool],
      }),
    });
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /event: tool-call-delta/);

    const rejected = await fetch(`${origin}/api/llm/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "chat",
        messages: [{ role: "user", content: "不要执行任何事" }],
        tools: [
          {
            type: "function",
            function: { name: "shell_exec", parameters: { type: "object" } },
          },
        ],
      }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    child.kill();
    await rm(folder, { recursive: true, force: true });
  }
});
