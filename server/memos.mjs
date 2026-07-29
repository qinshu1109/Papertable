import { createHash } from "node:crypto";

export const VERDICT_CUBE_ID = "papertable-verdicts";
const MCP_URL = "http://127.0.0.1:8002/mcp";
const MARKER = "papertable-verdict";
const MAX_LINE_LENGTH = 500;
const MAX_QUERY_LENGTH = 500;
// ponytail: MCP search currently has no cursor/list API and hard-caps top_k at
// 50. Replace this bounded window when MemOS exposes pagination.
const MAX_SEARCH_RESULTS = 50;
const LOCKED_FIELDS = [
  "verdict_type",
  "concepts",
  "source_kind",
  "source_id",
  "user_confirmed",
  "idempotency_key",
];
const GOLD_SOURCE_FIELDS = ["source_card_id", "source_turn_id"];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function text(value, name, max = 200) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value.trim()].length > max
  )
    throw new Error(`${name} 格式不正确。`);
  return value.trim();
}

function normalizeInput(input, supersedesMemoryId = null) {
  const projectId = text(input?.projectId, "projectId");
  const verdictType = input?.verdictType;
  if (!["tombstone", "gold"].includes(verdictType))
    throw new Error("verdictType 格式不正确。");
  const sourceKind = input?.sourceKind;
  if (!["edge", "turn"].includes(sourceKind))
    throw new Error("sourceKind 格式不正确。");
  const sourceId = text(input?.sourceId, "sourceId");
  const sourceCardId = input?.sourceCardId
    ? text(input.sourceCardId, "sourceCardId")
    : null;
  const sourceTurnId = input?.sourceTurnId
    ? text(input.sourceTurnId, "sourceTurnId")
    : null;
  if (Boolean(sourceCardId) !== Boolean(sourceTurnId))
    throw new Error("sourceCardId 和 sourceTurnId 必须同时提供。");
  if (
    (verdictType === "gold" &&
      (sourceKind !== "turn" ||
        !sourceCardId ||
        !sourceTurnId ||
        sourceId !== sourceTurnId)) ||
    (verdictType === "tombstone" &&
      (sourceKind !== "edge" || sourceCardId || sourceTurnId))
  )
    throw new Error("判决类型与来源不匹配。");
  const content = text(input?.content, "content", MAX_LINE_LENGTH);
  if (/[\r\n]/.test(content)) throw new Error("判决必须是单行。");
  const concepts = [...new Set(input?.concepts ?? [])].map((value) =>
    text(value, "concept", 80),
  );
  if (!concepts.length || concepts.length > 16)
    throw new Error("concepts 必须包含 1 到 16 个概念。");
  const keyParts = [
    projectId,
    verdictType,
    sourceKind,
    sourceId,
    supersedesMemoryId,
  ];
  if (sourceCardId && sourceTurnId) keyParts.push(sourceCardId, sourceTurnId);
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify(keyParts))
    .digest("hex");
  return {
    projectId,
    verdictType,
    sourceKind,
    sourceId,
    ...(sourceCardId && sourceTurnId ? { sourceCardId, sourceTurnId } : {}),
    content,
    concepts,
    idempotencyKey,
  };
}

function memoryView(record) {
  const value = object(record);
  const view = object(value?.memory_view);
  const attributes = object(view?.attributes);
  const info = object(value?.metadata?.info);
  const tags = Array.isArray(value?.metadata?.tags) ? value.metadata.tags : [];
  const sourceCardId =
    typeof attributes?.source_card_id === "string"
      ? attributes.source_card_id
      : null;
  const sourceTurnId =
    typeof attributes?.source_turn_id === "string"
      ? attributes.source_turn_id
      : null;
  const verdictType = attributes?.verdict_type;
  const sourceKind = attributes?.source_kind;
  const sourceId = attributes?.source_id;
  if (
    typeof value?.memory_id !== "string" ||
    view?.semantic_type !== "decision" ||
    typeof view?.subject_id !== "string" ||
    view?.client_id !== "papertable" ||
    view?.subject_type !== "other" ||
    view?.status !== "activated" ||
    attributes?.user_confirmed !== true ||
    !["tombstone", "gold"].includes(verdictType) ||
    !Array.isArray(attributes?.concepts) ||
    typeof attributes?.source_kind !== "string" ||
    typeof attributes?.source_id !== "string" ||
    typeof attributes?.idempotency_key !== "string" ||
    !Array.isArray(view?.locked_fields) ||
    !LOCKED_FIELDS.every((field) => view.locked_fields.includes(field)) ||
    Boolean(sourceCardId) !== Boolean(sourceTurnId) ||
    (verdictType === "gold" &&
      (sourceKind !== "turn" ||
        !sourceCardId ||
        !sourceTurnId ||
        sourceId !== sourceTurnId)) ||
    (verdictType === "tombstone" &&
      (sourceKind !== "edge" || sourceCardId || sourceTurnId)) ||
    (sourceCardId &&
      !GOLD_SOURCE_FIELDS.every((field) =>
        view.locked_fields.includes(field),
      )) ||
    info?.hot_policy !== "exclude" ||
    !tags.includes("brain:ignore")
  ) {
    return null;
  }
  const raw = typeof value.memory === "string" ? value.memory : "";
  const legacyPrefix = `${MARKER}:${attributes.idempotency_key} `;
  const prefix = `${legacyPrefix}${attributes.concepts.join(" ")} | `;
  const content = raw.startsWith(prefix)
    ? raw.slice(prefix.length)
    : raw.startsWith(legacyPrefix)
      ? raw.slice(legacyPrefix.length)
      : null;
  if (content === null) return null;
  if (
    !content ||
    /[\r\n]/.test(content) ||
    [...content].length > MAX_LINE_LENGTH
  )
    return null;
  return {
    id: value.memory_id,
    projectId: view.subject_id,
    verdictType,
    concepts: attributes.concepts.filter((item) => typeof item === "string"),
    sourceKind,
    sourceId,
    ...(sourceCardId && sourceTurnId ? { sourceCardId, sourceTurnId } : {}),
    content,
    status: "confirmed",
    idempotencyKey: attributes.idempotency_key,
    supersedesMemoryId:
      typeof info?.supersedes_memory_id === "string"
        ? info.supersedes_memory_id
        : null,
  };
}

export class McpClient {
  constructor(url = MCP_URL, fetchImpl = fetch) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.nextId = 1;
  }

  async request(method, params = {}, sessionId) {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`MemOS HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message ?? "MemOS MCP 调用失败");
    return {
      result: body.result,
      sessionId: response.headers.get("mcp-session-id"),
    };
  }

  async call(name, args = {}) {
    const initialized = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "papertable-node", version: "0.1.0" },
    });
    const called = await this.request(
      "tools/call",
      { name, arguments: args },
      initialized.sessionId,
    );
    if (called.result?.isError)
      throw new Error(called.result.content?.[0]?.text ?? "MemOS 工具调用失败");
    const structured = object(called.result?.structuredContent);
    if (!structured) throw new Error("MemOS 返回格式不正确");
    return structured;
  }
}

export function createVerdictService(callTool) {
  const pending = new Map();
  const call = (name, args) => callTool(name, args);

  async function ensureCube() {
    const listed = await call("list_cubes", {});
    const cubes = Array.isArray(listed?.cubes) ? listed.cubes : [];
    if (cubes.some((cube) => cube?.cube_id === VERDICT_CUBE_ID))
      return { cubeId: VERDICT_CUBE_ID, created: false };
    try {
      await call("create_cube", {
        cube_id: VERDICT_CUBE_ID,
        name: "Papertable 判决簿",
        description:
          "仅保存 Papertable 用户确认的项目判决；按项目隔离，排除 Brain 与热记忆，只允许 supersede。",
        max_memories: 2000,
      });
      return { cubeId: VERDICT_CUBE_ID, created: true };
    } catch (error) {
      const retried = await call("list_cubes", {});
      if (
        Array.isArray(retried?.cubes) &&
        retried.cubes.some((cube) => cube?.cube_id === VERDICT_CUBE_ID)
      )
        return { cubeId: VERDICT_CUBE_ID, created: false };
      throw error;
    }
  }

  async function searchRaw(projectId, query) {
    const result = await call("search_memories", {
      query,
      cube_ids: [VERDICT_CUBE_ID],
      top_k: MAX_SEARCH_RESULTS,
      rerank: "off",
      search_mode: "fts",
      semantic_types: ["decision"],
      subject_types: ["other"],
      subject_ids: [projectId],
      statuses: ["activated"],
    });
    return (Array.isArray(result?.results) ? result.results : [])
      .map(memoryView)
      .filter((item) => item?.projectId === projectId);
  }

  async function findByKey(input) {
    const found = await searchRaw(input.projectId, input.idempotencyKey);
    return found.find((item) => item.idempotencyKey === input.idempotencyKey);
  }

  async function add(input, supersedesMemoryId = null) {
    const existing = await findByKey(input);
    if (existing) return { verdict: existing, created: false };
    const lockedFields =
      input.sourceCardId && input.sourceTurnId
        ? [...LOCKED_FIELDS, ...GOLD_SOURCE_FIELDS]
        : LOCKED_FIELDS;
    const result = await call("add_memory", {
      cube_id: VERDICT_CUBE_ID,
      content: `${MARKER}:${input.idempotencyKey} ${input.concepts.join(" ")} | ${input.content}`,
      tags: ["brain:ignore", "papertable-verdict"],
      source: `papertable:${input.sourceKind}:${input.sourceId}`,
      hot_policy: "exclude",
      semantic_type: "decision",
      subject_type: "other",
      subject_id: input.projectId,
      asserted_by: "user",
      client_id: "papertable",
      attributes: {
        verdict_type: input.verdictType,
        concepts: input.concepts,
        source_kind: input.sourceKind,
        source_id: input.sourceId,
        ...(input.sourceCardId && input.sourceTurnId
          ? {
              source_card_id: input.sourceCardId,
              source_turn_id: input.sourceTurnId,
            }
          : {}),
        user_confirmed: true,
        idempotency_key: input.idempotencyKey,
      },
      locked_fields: lockedFields,
      ...(supersedesMemoryId
        ? { supersedes_memory_id: supersedesMemoryId }
        : {}),
    });
    const record = await call("get_memory", {
      cube_id: VERDICT_CUBE_ID,
      memory_id: result.memory_id,
    });
    const verdict = memoryView(record);
    if (!verdict) throw new Error("MemOS 写入后校验失败");
    return { verdict, created: true };
  }

  async function serial(key, operation) {
    const current = pending.get(key);
    if (current) return current;
    const promise = operation().finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }

  return {
    async health() {
      const result = await call("health", {});
      if (result?.status !== "ok") throw new Error("MemOS 状态异常");
      return { available: true, cubeId: VERDICT_CUBE_ID };
    },
    ensureCube,
    async list(projectId, concept) {
      projectId = text(projectId, "projectId");
      const found = await searchRaw(projectId, MARKER);
      const superseded = new Set(
        found.map((item) => item.supersedesMemoryId).filter(Boolean),
      );
      const needle = concept
        ? text(concept, "concept", MAX_QUERY_LENGTH).toLocaleLowerCase()
        : null;
      const matches = (item) =>
        !needle ||
        item.content.toLocaleLowerCase().includes(needle) ||
        item.concepts.some(
          (value) =>
            value.toLocaleLowerCase().includes(needle) ||
            needle.includes(value.toLocaleLowerCase()),
        );
      return {
        verdicts: found.filter(
          (item) => !superseded.has(item.id) && matches(item),
        ),
        history: found.filter(matches),
      };
    },
    async confirm(raw) {
      const input = normalizeInput(raw);
      await ensureCube();
      return serial(input.idempotencyKey, () => add(input));
    },
    async supersede(memoryId, raw) {
      memoryId = text(memoryId, "memoryId");
      const original = memoryView(
        await call("get_memory", {
          cube_id: VERDICT_CUBE_ID,
          memory_id: memoryId,
        }),
      );
      if (!original) throw new Error("原判决不存在或格式不正确。");
      const input = normalizeInput(raw, memoryId);
      if (
        original.projectId !== input.projectId ||
        original.verdictType !== input.verdictType ||
        original.sourceKind !== input.sourceKind ||
        original.sourceId !== input.sourceId ||
        original.sourceCardId !== input.sourceCardId ||
        original.sourceTurnId !== input.sourceTurnId
      )
        throw new Error("修订必须保持项目、判决类型和来源。");
      return serial(input.idempotencyKey, () => add(input, memoryId));
    },
  };
}

export function unavailable(error) {
  void error;
  return {
    available: false,
    error: {
      code: "unavailable",
      message: "判决簿服务当前不可用，请稍后重试。",
    },
  };
}
