import type { VaultBridge } from "./types";

/**
 * web 端的空实现。**不是「暂未实现」**：浏览器里的网页碰不到你的硬盘，所以监听
 * 笔记目录、与 Obsidian 双向同步在 web 上是结构上不可能的，这也正是桌面外壳存在
 * 的理由。UI 靠 `available` 直接隐藏整个同步区域，不会出现点了没反应的按钮。
 */
const unavailable = () =>
  Promise.reject(new Error("vault 同步只在桌面版可用。"));

export const webVault: VaultBridge = {
  available: false,
  chooseVault: () => Promise.resolve(null),
  sync: unavailable,
  rename: unavailable,
  remove: unavailable,
  forget: () => Promise.resolve(0),
  watch: unavailable,
  resolveLink: () => Promise.resolve([]),
  indexedCount: () => Promise.resolve(0),
  conflicts: () => Promise.resolve([]),
  resolveConflict: unavailable,
};
