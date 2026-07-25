import { createReadStream, existsSync } from "node:fs";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractMessage,
  friendlyProviderError,
  relayOpenAiStream,
  sseEvent,
} from "./cozai.mjs";
import { emitFakeStream, fakeCompletion } from "./fake-provider.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distRoot = path.join(root, "dist");
const port = Number(process.env.PAPERTABLE_PORT ?? 8787);
const localConfigPath = path.resolve(
  process.env.PAPERTABLE_CONFIG_FILE ?? path.join(root, ".env.local"),
);
let providerConfig = {
  baseUrl: (process.env.COZAI_BASE_URL ?? "https://cozai.net/v1").replace(
    /\/+$/,
    "",
  ),
  model: process.env.COZAI_MODEL ?? "claude-opus-5",
  apiKey: process.env.COZAI_API_KEY ?? "",
};
const fakeModel = process.env.PAPERTABLE_FAKE_LLM === "1";
const serveDist = process.argv.includes("--serve-dist");
const allowedTasks = new Set(["chat", "concept-preview", "title", "concepts"]);
const managedConfigKeys = new Set([
  "COZAI_BASE_URL",
  "COZAI_MODEL",
  "COZAI_API_KEY",
]);

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validatePayload(payload) {
  if (!payload || !allowedTasks.has(payload.task)) return "不支持的模型任务。";
  if (!Array.isArray(payload.messages) || payload.messages.length === 0)
    return "缺少对话内容。";
  if (
    payload.messages.some(
      (message) =>
        !["system", "user", "assistant"].includes(message?.role) ||
        typeof message?.content !== "string",
    )
  ) {
    return "对话内容格式不正确。";
  }
  return null;
}

function publicProviderConfig(message) {
  return {
    baseUrl: providerConfig.baseUrl,
    model: providerConfig.model,
    hasApiKey: Boolean(providerConfig.apiKey),
    ...(message ? { message } : {}),
  };
}

function isLocalOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname;
    return ["127.0.0.1", "localhost", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

function normalizeProviderConfig(payload) {
  if (!payload || typeof payload !== "object")
    return { error: "配置内容不正确。" };
  if (typeof payload.baseUrl !== "string") return { error: "请输入接口地址。" };
  if (typeof payload.model !== "string" || !payload.model.trim())
    return { error: "请输入模型名称。" };
  if (payload.model.trim().length > 160 || /[\r\n]/.test(payload.model))
    return { error: "模型名称格式不正确。" };
  if (
    payload.apiKey !== undefined &&
    (typeof payload.apiKey !== "string" ||
      payload.apiKey.length > 1_000 ||
      /[\r\n]/.test(payload.apiKey))
  ) {
    return { error: "密钥格式不正确。" };
  }
  try {
    const url = new URL(payload.baseUrl.trim());
    const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !isLoopback) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return { error: "接口地址必须是 HTTPS，或本机 HTTP 地址。" };
    }
    return {
      value: {
        baseUrl: url.toString().replace(/\/+$/, ""),
        model: payload.model.trim(),
        // 空密钥代表保留原密钥，避免浏览器读取或回显密钥。
        apiKey:
          typeof payload.apiKey === "string" && payload.apiKey.trim()
            ? payload.apiKey.trim()
            : providerConfig.apiKey,
      },
    };
  } catch {
    return { error: "接口地址不是有效 URL。" };
  }
}

async function persistProviderConfig(config) {
  let existing = "";
  try {
    existing = await readFile(localConfigPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const preserved = existing
    .split(/\r?\n/)
    .filter((line) => {
      const key = line.match(/^\s*([A-Z_][A-Z0-9_]*)=/)?.[1];
      return !key || !managedConfigKeys.has(key);
    })
    .join("\n")
    .trim();
  const content = [
    "# 由 Papertable 的本机设置页维护；请勿提交此文件。",
    `COZAI_BASE_URL=${config.baseUrl}`,
    `COZAI_MODEL=${config.model}`,
    `COZAI_API_KEY=${config.apiKey}`,
    preserved,
    "",
  ]
    .filter(Boolean)
    .join("\n");
  const tempPath = `${localConfigPath}.${process.pid}.tmp`;
  await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, localConfigPath);
  await chmod(localConfigPath, 0o600);
}

function providerPayload(payload, stream) {
  return {
    model: providerConfig.model,
    stream,
    messages: payload.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    temperature:
      typeof payload.temperature === "number"
        ? Math.min(1, Math.max(0, payload.temperature))
        : 0.35,
  };
}

async function providerFetch(payload, stream, signal) {
  if (!providerConfig.apiKey) throw new Error("MISSING_API_KEY");
  return fetch(`${providerConfig.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${providerConfig.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(providerPayload(payload, stream)),
    signal,
  });
}

async function serveStatic(req, res) {
  const requestPath = decodeURIComponent(
    new URL(req.url, "http://localhost").pathname,
  );
  const relative =
    requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const destination = path.resolve(distRoot, relative);
  if (!destination.startsWith(distRoot))
    return json(res, 403, { message: "禁止访问" });
  let file = destination;
  try {
    if (!(await stat(file)).isFile()) throw new Error("not file");
  } catch {
    file = path.join(distRoot, "index.html");
  }
  const ext = path.extname(file);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
  };
  res.writeHead(200, {
    "content-type": contentTypes[ext] ?? "application/octet-stream",
    "cache-control": file.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && pathname === "/api/health") {
    if (fakeModel)
      return json(res, 200, {
        configured: true,
        model: "papertable-test-model",
        baseUrl: "local-test-provider",
        message: "本机验收模型已启用",
      });
    if (!providerConfig.apiKey)
      return json(res, 200, {
        configured: false,
        model: providerConfig.model,
        baseUrl: providerConfig.baseUrl,
        message: "未检测到 COZAI_API_KEY",
      });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${providerConfig.baseUrl}/models`, {
        headers: { authorization: `Bearer ${providerConfig.apiKey}` },
        signal: controller.signal,
      });
      return json(res, response.ok ? 200 : 502, {
        configured: response.ok,
        model: providerConfig.model,
        baseUrl: providerConfig.baseUrl,
        message: response.ok
          ? "连接正常"
          : friendlyProviderError(response.status),
      });
    } catch {
      return json(res, 502, {
        configured: false,
        model: providerConfig.model,
        baseUrl: providerConfig.baseUrl,
        message: "无法连接模型服务",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  if (req.method === "GET" && pathname === "/api/config") {
    if (fakeModel)
      return json(res, 200, {
        baseUrl: "local-test-provider",
        model: "papertable-test-model",
        hasApiKey: false,
        message: "本机验收模型已启用",
      });
    return json(res, 200, publicProviderConfig());
  }

  if (req.method === "POST" && pathname === "/api/config") {
    if (!isLocalOrigin(req))
      return json(res, 403, { message: "仅允许本机页面修改模型配置。" });
    if (fakeModel)
      return json(res, 409, {
        message: "本机验收模型启用时不能修改真实模型配置。",
      });
    let payload;
    try {
      payload = await readJson(req);
    } catch {
      return json(res, 400, { message: "请求内容不是有效 JSON。" });
    }
    const result = normalizeProviderConfig(payload);
    if (result.error) return json(res, 400, { message: result.error });
    try {
      await persistProviderConfig(result.value);
      providerConfig = result.value;
      return json(res, 200, publicProviderConfig("已保存本机配置。"));
    } catch {
      return json(res, 500, {
        message: "无法写入本机配置，请确认项目目录可写。",
      });
    }
  }

  if (req.method === "POST" && pathname === "/api/llm/stream") {
    let payload;
    try {
      payload = await readJson(req);
    } catch {
      return json(res, 400, { message: "请求内容不是有效 JSON。" });
    }
    const validationError = validatePayload(payload);
    if (validationError) return json(res, 400, { message: validationError });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.flushHeaders();
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      if (fakeModel) {
        await emitFakeStream({
          payload,
          write: (chunk) => res.write(chunk),
          signal: controller.signal,
        });
      } else if (!providerConfig.apiKey) {
        res.write(
          sseEvent("error", {
            message:
              "未配置 COZAI_API_KEY，请在 .env.local 中填写轮换后的密钥。",
            status: 401,
          }),
        );
        res.write(sseEvent("done", { stopped: false }));
      } else {
        const upstream = await providerFetch(payload, true, controller.signal);
        await relayOpenAiStream({
          upstream,
          write: (chunk) => res.write(chunk),
          signal: controller.signal,
        });
      }
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "模型请求超时或已停止。"
          : "无法连接模型服务，请检查网络和配置。";
      res.write(sseEvent("error", { message }));
      res.write(sseEvent("done", { stopped: controller.signal.aborted }));
    } finally {
      clearTimeout(timeout);
      res.end();
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/llm/generate") {
    let payload;
    try {
      payload = await readJson(req);
    } catch {
      return json(res, 400, { message: "请求内容不是有效 JSON。" });
    }
    const validationError = validatePayload(payload);
    if (validationError) return json(res, 400, { message: validationError });
    if (fakeModel) return json(res, 200, { content: fakeCompletion(payload) });
    if (!providerConfig.apiKey)
      return json(res, 401, {
        message: "未配置 COZAI_API_KEY，请在 .env.local 中填写轮换后的密钥。",
      });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const upstream = await providerFetch(payload, false, controller.signal);
      const body = await upstream.text();
      if (!upstream.ok)
        return json(res, upstream.status, {
          message: friendlyProviderError(upstream.status, body),
        });
      const content = extractMessage(JSON.parse(body));
      return json(res, 200, { content });
    } catch (error) {
      return json(res, error?.name === "AbortError" ? 504 : 502, {
        message:
          error?.name === "AbortError"
            ? "模型请求超时。"
            : "无法连接模型服务。",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  if (serveDist && req.method === "GET" && existsSync(distRoot))
    return serveStatic(req, res);
  return json(res, 404, { message: "未找到请求。" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Papertable local API listening on http://127.0.0.1:${port}`);
});
