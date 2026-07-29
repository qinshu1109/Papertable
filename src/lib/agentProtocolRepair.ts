import type {
  ProviderErrorCode,
  ProviderStreamEvent,
  ToolCall,
} from "../types";

const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/g;
const TOOL_PROTOCOL_TAG_RE =
  /<\s*\/?\s*(?:tool_calls?|function_calls?|tool_use|invoke|parameter)(?:\s[^<>]*)?>|<\|[^|<>]+\|>/iu;
const TOOL_PROTOCOL_TAG_PREFIXES = [
  "tool_call",
  "tool_calls",
  "function_call",
  "function_calls",
  "tool_use",
  "invoke",
  "parameter",
];

export function visibleProtocolPrefix(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .toLowerCase();
  const start = normalized.lastIndexOf("<");
  if (start < 0) return false;
  const tail = normalized.slice(start);
  if (tail.includes(">")) return false;
  const compact = tail.replace(/\s+/g, "");
  if ("<|".startsWith(compact) || compact.startsWith("<|")) return true;
  const candidate = compact.replace(/^<\//, "<");
  return TOOL_PROTOCOL_TAG_PREFIXES.some(
    (name) =>
      `<${name}`.startsWith(candidate) || candidate.startsWith(`<${name}`),
  );
}

export const PROTOCOL_RETRY_CLASSIFICATION = {
  unauthorized: {
    action: "fail",
    maxRetries: 0,
    backoffMs: [],
  },
  "rate-limited": {
    action: "retry-with-backoff",
    maxRetries: 2,
    backoffMs: [250, 750],
  },
  "service-unavailable": {
    action: "retry",
    maxRetries: 2,
    backoffMs: [0, 0],
  },
  upstream: {
    action: "retry",
    maxRetries: 2,
    backoffMs: [0, 0],
  },
  disconnected: {
    action: "retry",
    maxRetries: 2,
    backoffMs: [0, 0],
  },
  timeout: {
    action: "retry",
    maxRetries: 2,
    backoffMs: [0, 0],
  },
  "empty-response": {
    action: "retry",
    maxRetries: 2,
    backoffMs: [0, 0],
  },
  "invalid-response": {
    action: "repair-protocol",
    maxRetries: 0,
    backoffMs: [],
  },
} as const satisfies Record<
  ProviderErrorCode,
  {
    action: "fail" | "retry" | "retry-with-backoff" | "repair-protocol";
    maxRetries: number;
    backoffMs: readonly number[];
  }
>;

export function normalizeToolProtocolText(value: string): {
  value: string;
  changed: boolean;
  removedZeroWidth: boolean;
  normalizedNfkc: boolean;
  containsProtocolTag: boolean;
} {
  const nfkc = value.normalize("NFKC");
  const normalized = nfkc.replace(ZERO_WIDTH_RE, "");
  return {
    value: normalized,
    changed: normalized !== value,
    removedZeroWidth: nfkc !== normalized,
    normalizedNfkc: nfkc !== value,
    containsProtocolTag: TOOL_PROTOCOL_TAG_RE.test(normalized),
  };
}

type PartialToolCall = {
  id?: string;
  name?: string;
  arguments: string;
  argumentFragments: number;
};

export interface ToolProtocolAssembly {
  calls: ToolCall[];
  issue?: string;
  deterministicActions: string[];
}

function legalObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}

function assembleOne(call: PartialToolCall): {
  call?: ToolCall;
  issue?: string;
  deterministicActions: string[];
} {
  const deterministicActions: string[] = [];
  if (!call.id) return { issue: "tool_call 缺少 id。", deterministicActions };
  if (call.name === undefined)
    return { issue: "tool_call 缺少工具名。", deterministicActions };

  const normalizedName = normalizeToolProtocolText(call.name);
  if (normalizedName.containsProtocolTag)
    return {
      issue: "工具名包含工具协议标签。",
      deterministicActions,
    };
  if (normalizedName.normalizedNfkc)
    deterministicActions.push("工具名执行 NFKC 归一化");
  if (normalizedName.removedZeroWidth)
    deterministicActions.push("工具名移除零宽字符");
  if (
    normalizedName.value !== "search_notes" &&
    normalizedName.value !== "read_notes"
  )
    return {
      issue: normalizedName.value
        ? "工具名不在原生只读工具白名单中。"
        : "tool_call 工具名为空。",
      deterministicActions,
    };

  if (!call.arguments)
    return { issue: "tool_call 缺少完整参数。", deterministicActions };
  const normalizedArguments = normalizeToolProtocolText(call.arguments);
  if (normalizedArguments.containsProtocolTag)
    return {
      issue: "工具参数包含工具协议标签，不能无歧义地当作 JSON。",
      deterministicActions,
    };
  let argumentsValue = call.arguments;
  if (!legalObject(argumentsValue)) {
    if (!normalizedArguments.changed || !legalObject(normalizedArguments.value))
      return {
        issue: "工具参数不是完整的 JSON 对象。",
        deterministicActions,
      };
    argumentsValue = normalizedArguments.value;
    if (normalizedArguments.normalizedNfkc)
      deterministicActions.push("工具参数执行 NFKC 归一化");
    if (normalizedArguments.removedZeroWidth)
      deterministicActions.push("工具参数移除零宽字符");
  }

  return {
    call: {
      id: call.id,
      name: normalizedName.value,
      arguments: argumentsValue,
    },
    deterministicActions,
  };
}

/**
 * Reassembles only fragments emitted for the same provider index, in arrival
 * order. It never supplies a missing id/name, defaults arguments to `{}`, or
 * attempts to close truncated JSON.
 */
export function assembleToolProtocol(
  events: readonly ProviderStreamEvent[],
): ToolProtocolAssembly {
  const partial = new Map<number, PartialToolCall>();
  for (const event of events) {
    if (event.type !== "tool-call-delta") continue;
    const current = partial.get(event.index) ?? {
      arguments: "",
      argumentFragments: 0,
    };
    if (event.id !== undefined) current.id = event.id;
    if (event.name !== undefined) current.name = event.name;
    if (event.arguments !== undefined) {
      current.arguments += event.arguments;
      current.argumentFragments += 1;
    }
    partial.set(event.index, current);
  }
  const calls: ToolCall[] = [];
  const deterministicActions: string[] = [];
  for (const [, partialCall] of [...partial.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    const assembled = assembleOne(partialCall);
    if (partialCall.argumentFragments > 1)
      deterministicActions.push("工具参数按流式片段到达顺序无损重组");
    deterministicActions.push(...assembled.deterministicActions);
    if (!assembled.call)
      return {
        calls: [],
        issue: assembled.issue ?? "工具调用协议不完整。",
        deterministicActions,
      };
    calls.push(assembled.call);
  }
  return { calls, deterministicActions };
}

export function validateCompletedToolProtocol(
  calls: readonly ToolCall[],
): ToolProtocolAssembly {
  const validated: ToolCall[] = [];
  const deterministicActions: string[] = [];
  for (const call of calls) {
    const assembled = assembleOne({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      argumentFragments: 1,
    });
    deterministicActions.push(...assembled.deterministicActions);
    if (!assembled.call)
      return {
        calls: [],
        issue: assembled.issue ?? "工具调用协议不完整。",
        deterministicActions,
      };
    validated.push(assembled.call);
  }
  return { calls: validated, deterministicActions };
}

export function visibleProtocolLeak(
  events: readonly ProviderStreamEvent[],
): boolean {
  const text = events
    .filter(
      (event): event is Extract<ProviderStreamEvent, { type: "token" }> =>
        event.type === "token",
    )
    .map((event) => event.text)
    .join("");
  return text
    ? normalizeToolProtocolText(text).containsProtocolTag ||
        visibleProtocolPrefix(text)
    : false;
}
