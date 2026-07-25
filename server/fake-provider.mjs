import { sseEvent } from "./cozai.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeCompletion(payload) {
  const lastUser = [...payload.messages]
    .reverse()
    .find((message) => message.role === "user")?.content;
  const topic = lastUser?.replace(/\s+/g, " ").slice(0, 42) || "这个问题";
  if (payload.task === "title") return "本地验收测试";
  if (payload.task === "concepts") return "[]";
  return `这是本地验收用的流式回答：${topic}。\n\n它用于验证卡片、上下文、停止与自动保存链路；正式运行时会由 CozAI · Claude Opus 5 回答。`;
}

export async function emitFakeStream({ payload, write, signal }) {
  const content = fakeCompletion(payload);
  for (const part of content.match(/.{1,8}/gu) ?? []) {
    if (signal?.aborted) break;
    write(sseEvent("token", { text: part }));
    await sleep(25);
  }
  write(sseEvent("done", { stopped: Boolean(signal?.aborted) }));
}
