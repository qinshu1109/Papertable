import type { ToolCall } from "../types";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(",")}}`;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Canonicalizes JSON structure only: object keys are sorted while array order,
 * strings, values, and optional/default argument semantics remain untouched.
 * Invalid or non-object arguments stay in the exception path and never become
 * successful-call signatures.
 */
export function successfulToolCallSignature(
  call: Pick<ToolCall, "name" | "arguments">,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const canonical = canonicalJson(parsed);
  return `${call.name}:${fnv1a64(`${call.name}\u0000${canonical}`)}`;
}
