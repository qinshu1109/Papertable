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
