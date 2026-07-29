import type {
  VerdictHealth,
  VerdictHost,
  VerdictInput,
  VerdictList,
  VerdictResponse,
  VerdictWriteResult,
} from "./types";

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<VerdictResponse<T>> {
  try {
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
    const body = (await response.json()) as VerdictResponse<T>;
    if (
      typeof body !== "object" ||
      body === null ||
      typeof body.available !== "boolean"
    )
      throw new Error("判决簿返回格式不正确");
    return body;
  } catch {
    return {
      available: false,
      error: {
        code: "unavailable",
        message: "判决簿服务当前不可用，请稍后重试。",
      },
    };
  }
}

export const webVerdicts: VerdictHost = {
  health: () => request<VerdictHealth>("/api/verdicts/health"),
  ensureCube: () =>
    request("/api/verdicts/ensure", { method: "POST", body: "{}" }),
  list: (projectId, concept) => {
    const query = new URLSearchParams({ projectId });
    if (concept) query.set("concept", concept);
    return request<VerdictList>(`/api/verdicts?${query}`);
  },
  confirm: (input: VerdictInput) =>
    request<VerdictWriteResult>("/api/verdicts/confirm", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  supersede: (memoryId: string, input: VerdictInput) =>
    request<VerdictWriteResult>("/api/verdicts/supersede", {
      method: "POST",
      body: JSON.stringify({ memoryId, input }),
    }),
};
