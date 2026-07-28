import { createReadStream, existsSync } from "node:fs";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractMessage,
  extractUsage,
  extractToolCalls,
  friendlyProviderError,
  gatewayResponseShape,
  OPENAI_GATEWAY_RESPONSE_SHAPE,
  providerErrorMessage,
  relayOpenAiStream,
  sseEvent,
} from "./cozai.mjs";

const PROTOCOL_ADAPTER_VERSION = "openai-native-tools-v1";
import {
  emitFakeStream,
  fakeCompletion,
  fakeToolCalls,
} from "./fake-provider.mjs";

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
const allowedTasks = new Set([
  "chat",
  "agent",
  "concept-preview",
  "title",
  "concepts",
]);
const allowedToolNames = new Set([
  "search_notes",
  "read_notes",
  // 仅供本机能力探测使用；浏览器请求不能声明这个工具。
  "papertable_probe",
]);
const clientToolNames = new Set(["search_notes", "read_notes"]);
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageToolCalls(message) {
  const calls = message?.toolCalls ?? message?.tool_calls;
  return Array.isArray(calls) ? calls : [];
}

function toolFunction(tool) {
  if (!isPlainObject(tool)) return null;
  return isPlainObject(tool.function) ? tool.function : tool;
}

function toolName(tool) {
  return toolFunction(tool)?.name;
}

function validateToolCalls(calls, allowedNames = clientToolNames) {
  if (!Array.isArray(calls) || calls.length > 8) return "工具调用格式不正确。";
  for (const call of calls) {
    const functionCall = isPlainObject(call?.function) ? call.function : call;
    if (
      !isPlainObject(call) ||
      typeof call.id !== "string" ||
      !call.id ||
      call.id.length > 200 ||
      typeof functionCall?.name !== "string" ||
      !allowedNames.has(functionCall.name) ||
      (functionCall.arguments !== undefined &&
        (typeof functionCall.arguments !== "string" ||
          functionCall.arguments.length > 32_000))
    ) {
      return "工具调用格式不正确。";
    }
  }
  return null;
}

function validateTools(tools, allowedNames = clientToolNames) {
  if (tools === undefined) return null;
  if (!Array.isArray(tools) || tools.length > 2) return "工具定义格式不正确。";
  const names = new Set();
  for (const tool of tools) {
    const functionTool = toolFunction(tool);
    const name = functionTool?.name;
    if (
      !functionTool ||
      typeof name !== "string" ||
      !allowedNames.has(name) ||
      names.has(name) ||
      (tool.type !== undefined && tool.type !== "function") ||
      (functionTool.description !== undefined &&
        (typeof functionTool.description !== "string" ||
          functionTool.description.length > 4_000)) ||
      (functionTool.parameters !== undefined &&
        (!isPlainObject(functionTool.parameters) ||
          JSON.stringify(functionTool.parameters).length > 16_000))
    ) {
      return "工具定义格式不正确。";
    }
    names.add(name);
  }
  return null;
}

function requestedToolChoice(payload) {
  return payload?.toolChoice ?? payload?.tool_choice;
}

function validateToolChoice(choice, toolNames) {
  if (choice === undefined) return null;
  if (["auto", "none", "required"].includes(choice)) return null;
  const name = isPlainObject(choice) && (choice.function?.name ?? choice.name);
  if (
    !isPlainObject(choice) ||
    (choice.type !== undefined && choice.type !== "function") ||
    typeof name !== "string" ||
    !toolNames.has(name)
  ) {
    return "工具选择格式不正确。";
  }
  return null;
}

function validatePayload(payload, { allowProbeTool = false } = {}) {
  if (!payload || !allowedTasks.has(payload.task)) return "不支持的模型任务。";
  if (!Array.isArray(payload.messages) || payload.messages.length === 0)
    return "缺少对话内容。";
  const allowedNames = allowProbeTool ? allowedToolNames : clientToolNames;
  for (const message of payload.messages) {
    if (!isPlainObject(message)) return "对话内容格式不正确。";
    if (!["system", "user", "assistant", "tool"].includes(message.role))
      return "对话内容格式不正确。";
    const calls = messageToolCalls(message);
    if (message.role === "assistant") {
      if (
        !["string", "object"].includes(typeof message.content) ||
        (message.content !== null && typeof message.content !== "string")
      ) {
        return "对话内容格式不正确。";
      }
      const toolError = validateToolCalls(calls, allowedNames);
      if (toolError) return toolError;
      if (message.content === null && calls.length === 0)
        return "对话内容格式不正确。";
      continue;
    }
    if (typeof message.content !== "string" || message.content.length > 160_000)
      return "对话内容格式不正确。";
    if (message.role === "tool") {
      const toolCallId = message.toolCallId ?? message.tool_call_id;
      if (
        typeof toolCallId !== "string" ||
        !toolCallId ||
        toolCallId.length > 200 ||
        calls.length
      ) {
        return "对话内容格式不正确。";
      }
    } else if (calls.length) {
      return "对话内容格式不正确。";
    }
  }
  const toolError = validateTools(payload.tools, allowedNames);
  if (toolError) return toolError;
  const names = new Set((payload.tools ?? []).map(toolName));
  const choiceError = validateToolChoice(requestedToolChoice(payload), names);
  if (choiceError) return choiceError;
  if (payload.tools?.length && !["chat", "agent"].includes(payload.task))
    return "当前模型任务不支持工具调用。";
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

function normalizeToolCall(call) {
  const functionCall = isPlainObject(call?.function) ? call.function : call;
  return {
    id: call.id,
    type: "function",
    function: {
      name: functionCall.name,
      arguments:
        typeof functionCall.arguments === "string"
          ? functionCall.arguments
          : "{}",
    },
  };
}

function normalizeTool(tool) {
  const functionTool = toolFunction(tool);
  return {
    type: "function",
    function: {
      name: functionTool.name,
      ...(typeof functionTool.description === "string"
        ? { description: functionTool.description }
        : {}),
      ...(functionTool.parameters
        ? { parameters: functionTool.parameters }
        : {}),
    },
  };
}

function normalizeToolChoice(choice) {
  if (choice === undefined || typeof choice === "string") return choice;
  const name = choice.function?.name ?? choice.name;
  return { type: "function", function: { name } };
}

function providerPayload(payload, stream) {
  const tools = Array.isArray(payload.tools)
    ? payload.tools.map(normalizeTool)
    : [];
  const toolChoice = normalizeToolChoice(requestedToolChoice(payload));
  return {
    model: providerConfig.model,
    stream,
    ...(stream && payload.task === "agent"
      ? { stream_options: { include_usage: true } }
      : {}),
    messages: payload.messages.map((message) => {
      if (message.role === "assistant") {
        const calls = messageToolCalls(message);
        return {
          role: "assistant",
          content: message.content ?? null,
          ...(calls.length ? { tool_calls: calls.map(normalizeToolCall) } : {}),
        };
      }
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.toolCallId ?? message.tool_call_id,
          content: message.content,
        };
      }
      return { role: message.role, content: message.content };
    }),
    ...(tools.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
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

const probeTool = {
  type: "function",
  function: {
    name: "papertable_probe",
    description: "Papertable 本机模型能力探测工具。",
    parameters: {
      type: "object",
      properties: { probe: { type: "string" } },
      required: ["probe"],
      additionalProperties: false,
    },
  },
};

function probeRequest() {
  return {
    task: "agent",
    messages: [
      {
        role: "user",
        content: "请只调用 papertable_probe，参数 probe 为 ok。",
      },
    ],
    tools: [probeTool],
    toolChoice: { type: "function", function: { name: "papertable_probe" } },
    temperature: 0,
  };
}

function parseSseEventText(text, eventName) {
  return text
    .split("\n\n")
    .filter((part) => part.startsWith(`event: ${eventName}\n`))
    .map((part) => {
      const data = part.match(/^event: [^\n]+\ndata: (.*)$/ms)?.[1];
      try {
        return data ? JSON.parse(data) : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Probe only the OpenAI-compatible protocol, never cache the answer here.
 * The browser/desktop host owns a safe per-(baseUrl, model) cache because a
 * local configuration change must invalidate capabilities immediately.
 */
async function probeProviderCapabilities(signal) {
  const testedAt = new Date().toISOString();
  const stage = (status, detail) => ({
    status,
    ...(detail ? { detail } : {}),
  });
  if (fakeModel) {
    return {
      mode: "native-tools",
      protocolAdapterVersion: PROTOCOL_ADAPTER_VERSION,
      gatewayResponseShape: OPENAI_GATEWAY_RESPONSE_SHAPE,
      toolCallEmission: stage("passed"),
      toolResultAcceptance: stage("passed"),
      streamingToolCallDelta: stage("passed"),
      testedAt,
    };
  }
  if (!providerConfig.apiKey) {
    return {
      mode: "unavailable",
      protocolAdapterVersion: PROTOCOL_ADAPTER_VERSION,
      gatewayResponseShape: "unknown",
      toolCallEmission: stage("failed", "未配置模型密钥。"),
      toolResultAcceptance: stage("not-run", "工具调用发出阶段未通过。"),
      streamingToolCallDelta: stage("not-run", "未配置模型密钥。"),
      testedAt,
      unavailableReason: "未配置模型密钥，Agent 模式不可用。",
    };
  }

  let toolCallEmission;
  let toolResultAcceptance = stage("not-run", "工具调用发出阶段未通过。");
  let streamingToolCallDelta;
  let observedShape = "unknown";
  let gatewayShapeValid = true;
  const observeShape = (shape, required = false) => {
    if (shape === "unknown") {
      if (required) gatewayShapeValid = false;
      return;
    }
    if (shape !== OPENAI_GATEWAY_RESPONSE_SHAPE) {
      gatewayShapeValid = false;
      observedShape = shape;
      return;
    }
    if (observedShape === "unknown") observedShape = shape;
  };
  let responseMessage;
  let calls = [];
  try {
    const response = await providerFetch(probeRequest(), false, signal);
    const body = await response.text();
    if (!response.ok) {
      toolCallEmission = stage(
        "failed",
        friendlyProviderError(response.status, body),
      );
    } else {
      const parsed = JSON.parse(body);
      observeShape(gatewayResponseShape(parsed), true);
      calls = extractToolCalls(parsed);
      responseMessage = extractMessage(parsed);
      toolCallEmission = calls.length
        ? stage("passed")
        : stage("failed", "没有返回强制工具调用。");
    }
  } catch (caught) {
    toolCallEmission = stage(
      "failed",
      caught?.name === "AbortError"
        ? "模型能力探测超时。"
        : "无法连接模型服务。",
    );
  }

  if (toolCallEmission.status === "passed") {
    try {
      const first = calls[0];
      const response = await providerFetch(
        {
          ...probeRequest(),
          messages: [
            ...probeRequest().messages,
            {
              role: "assistant",
              content: responseMessage || null,
              toolCalls: calls,
            },
            {
              role: "tool",
              toolCallId: first.id,
              content: '{"ok":true}',
            },
          ],
          toolChoice: "none",
        },
        false,
        signal,
      );
      const body = await response.text();
      if (response.ok) {
        // 2xx is enough: this specifically checks that the provider accepts
        // assistant tool_calls + a tool-role result, not prose quality.
        toolResultAcceptance = stage("passed");
        try {
          observeShape(gatewayResponseShape(JSON.parse(body)));
        } catch {
          // The acceptance stage is deliberately transport-only. The initial
          // and streaming stages own response-shape validation.
        }
      } else {
        toolResultAcceptance = stage(
          "failed",
          friendlyProviderError(response.status, body),
        );
      }
    } catch (caught) {
      toolResultAcceptance = stage(
        "failed",
        caught?.name === "AbortError"
          ? "模型能力探测超时。"
          : "模型不接受工具结果回填。",
      );
    }
  }

  try {
    const response = await providerFetch(probeRequest(), true, signal);
    const chunks = [];
    await relayOpenAiStream({
      upstream: response,
      write: (chunk) => chunks.push(new TextDecoder().decode(chunk)),
      signal,
    });
    const output = chunks.join("");
    const deltas = parseSseEventText(output, "tool-call-delta");
    const done = parseSseEventText(output, "done").at(-1);
    observeShape(
      typeof done?.gatewayResponseShape === "string"
        ? done.gatewayResponseShape
        : "unknown",
      true,
    );
    streamingToolCallDelta = deltas.length
      ? stage("passed")
      : stage("failed", "没有返回流式工具调用增量。");
  } catch (caught) {
    streamingToolCallDelta = stage(
      "failed",
      caught?.name === "AbortError"
        ? "模型能力探测超时。"
        : "模型不支持流式工具调用。",
    );
  }

  const nativeTools =
    toolCallEmission.status === "passed" &&
    toolResultAcceptance.status === "passed" &&
    streamingToolCallDelta.status === "passed" &&
    gatewayShapeValid &&
    observedShape === OPENAI_GATEWAY_RESPONSE_SHAPE;
  const unavailableReason = !nativeTools
    ? "三段原生工具握手未全部通过，Agent 模式不可用。"
    : undefined;
  return {
    mode: nativeTools ? "native-tools" : "unavailable",
    protocolAdapterVersion: PROTOCOL_ADAPTER_VERSION,
    gatewayResponseShape: observedShape,
    toolCallEmission,
    toolResultAcceptance,
    streamingToolCallDelta,
    testedAt,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
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
        message: "尚未配置模型密钥，请在设置页填写。",
      });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      // Some OpenAI-compatible gateways do not expose /models even though
      // chat completions work.  Probe the exact configured model instead so
      // the settings page never reports a false negative for a usable route.
      const response = await providerFetch(
        {
          task: "chat",
          messages: [{ role: "user", content: "请只回复 ok。" }],
          temperature: 0,
        },
        false,
        controller.signal,
      );
      return json(res, response.ok ? 200 : 502, {
        configured: response.ok,
        model: providerConfig.model,
        baseUrl: providerConfig.baseUrl,
        message: response.ok
          ? "连接正常"
          : friendlyProviderError(response.status),
      });
    } catch {
      const message = controller.signal.aborted
        ? providerErrorMessage("timeout")
        : providerErrorMessage("disconnected");
      return json(res, 502, {
        configured: false,
        model: providerConfig.model,
        baseUrl: providerConfig.baseUrl,
        message,
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

  if (req.method === "POST" && pathname === "/api/llm/capabilities") {
    if (!isLocalOrigin(req))
      return json(res, 403, { message: "仅允许本机页面探测模型能力。" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      return json(res, 200, await probeProviderCapabilities(controller.signal));
    } catch {
      return json(res, 200, {
        mode: "unavailable",
        protocolAdapterVersion: PROTOCOL_ADAPTER_VERSION,
        gatewayResponseShape: "unknown",
        toolCallEmission: {
          status: "failed",
          detail: "模型能力探测失败。",
        },
        toolResultAcceptance: {
          status: "not-run",
          detail: "工具调用发出阶段未通过。",
        },
        streamingToolCallDelta: {
          status: "not-run",
          detail: "模型能力探测失败。",
        },
        testedAt: new Date().toISOString(),
        unavailableReason: "模型能力探测失败，Agent 模式不可用。",
      });
    } finally {
      clearTimeout(timeout);
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
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 120_000);
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
            message: providerErrorMessage("unauthorized"),
            code: "unauthorized",
          }),
        );
        res.write(sseEvent("done", { stopped: false }));
      } else {
        const upstream = await providerFetch(payload, true, controller.signal);
        await relayOpenAiStream({
          upstream,
          write: (chunk) => res.write(chunk),
          signal: controller.signal,
          timeoutCode: timedOut ? "timeout" : undefined,
        });
      }
    } catch {
      const code = timedOut ? "timeout" : "disconnected";
      if (!controller.signal.aborted || timedOut) {
        res.write(
          sseEvent("error", { message: providerErrorMessage(code), code }),
        );
      }
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
    if (fakeModel) {
      const toolCalls = fakeToolCalls(payload);
      return json(res, 200, {
        content: toolCalls.length ? "" : fakeCompletion(payload),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    }
    if (!providerConfig.apiKey)
      return json(res, 401, {
        message: providerErrorMessage("unauthorized"),
        code: "unauthorized",
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
      const parsed = JSON.parse(body);
      const content = extractMessage(parsed);
      const toolCalls = extractToolCalls(parsed);
      const usage = extractUsage(parsed);
      return json(res, 200, {
        content,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(usage ? { usage } : {}),
      });
    } catch (error) {
      const code = error?.name === "AbortError" ? "timeout" : "disconnected";
      return json(res, code === "timeout" ? 504 : 502, {
        message: providerErrorMessage(code),
        code,
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
