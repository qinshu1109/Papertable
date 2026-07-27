import assert from "node:assert/strict";
import test from "node:test";
import { createStreamThrottle } from "./streamThrottle";

test("高频 token 只安排一次提交，并只提交最新正文", () => {
  const callbacks = new Map<number, () => void>();
  const committed: string[] = [];
  let nextId = 0;
  const throttle = createStreamThrottle<string>({
    commit: (value) => committed.push(value),
    schedule: (callback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancel: (id) => callbacks.delete(id),
    delayForNextCommit: () => 80,
  });

  for (let index = 1; index <= 100; index += 1)
    throttle.push("字".repeat(index));

  assert.equal(callbacks.size, 1);
  callbacks.values().next().value?.();
  assert.deepEqual(committed, ["字".repeat(100)]);
});

test("flush 立即提交最后正文并取消等待中的刷新", () => {
  const callbacks = new Map<number, () => void>();
  const committed: string[] = [];
  let nextId = 0;
  const throttle = createStreamThrottle<string>({
    commit: (value) => committed.push(value),
    schedule: (callback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancel: (id) => callbacks.delete(id),
    delayForNextCommit: () => 400,
  });

  throttle.push("后台生成的最新内容");
  throttle.flush();

  assert.deepEqual(committed, ["后台生成的最新内容"]);
  assert.equal(callbacks.size, 0);
});
