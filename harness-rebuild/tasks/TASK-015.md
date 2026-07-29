---
id: TASK-015
title: 判决检索、冻结注入与 A/B 审计
status: in_progress
depends_on: [TASK-014]
parallelizable: false
isolation: outputs/task-015/
merge_strategy: human-review
verify: 回答开始前由宿主以 projectId+当前问题+卡片标题+Card.concepts 检索并冻结 confirmed 链尾判决；buildContext 保持同步纯函数并生成 verdict provenance；Turn 持久化 promptVersion、注入开关、命中 id/类型/冻结行及不可用态；A/B 开关可复现；跨项目、proposed、superseded、超长/多行/控制字符均不能注入；MemOS 故障不阻断普通回答且不会伪装为已召回
---

## 任务内容

在每轮回答真正拼装上下文前，由 Store 调用 TASK-014 的外接通道，以 `projectId` 强过滤，并以当前问题、当前卡标题和 `Card.concepts` 组成概念检索词。检索结果先由宿主过滤 confirmed 与 supersede 链尾，再冻结为本轮 `VerdictContextItem[]`，作为显式参数传给同步纯函数 `buildContext()`。

新增 `ContextProvenance.kind="verdict"`。判决块位于 system 层，但动态内容必须先 NFC 归一化、去控制字符、压成一行、执行字符上限，并以惰性 JSON 字面量呈现；提示词明确区分金子锚点与墓碑负面约束，墓碑只禁止把旧方向重新当默认答案，不禁止在关键前提改变时说明为何重审。

为每轮保存冻结审计 `Turn.verdictTrace`：prompt 版本、A/B 开关、检索词、注入判决 id/类型/一行快照、MemOS 不可用状态。它只证明本轮用过什么，不是真值，不授予笔记引用资格，也不进入普通 Markdown/Canvas 导出；无损包保留。

## 输入

- ADR-008 与 TASK-014 的判决 DTO、通道、契约证据
- `src/lib/context.ts`
- `src/store.tsx` 的回答入口
- Web Dexie / Desktop SQLite 的 Turn 持久化与无损格式

## 预期输出

- 宿主冻结的判决检索与注入管线
- `verdict` provenance 和可查看的本轮审计
- 显式 `VERDICT_PROMPT_VERSION` 与内部 A/B 开关
- Web、Rust、格式往返、项目隔离与故障回归测试
- `outputs/task-015/` 下的注入开/关注入关、跨项目和不可用 fixture

## 边界

- `buildContext()` 不联网、不变成 async。
- 模型不能提供 Cube、projectId、scope、判决 id 或检索上限。
- 判决不是 `sources-only` 的笔记引用，不改变 controlled citations。
- 不在本卡实现墓碑确认、金子采纳或判决簿首页。
- 不把 MemOS 故障静默解释成“项目没有判决”。

## 重点验收

1. 相同输入与冻结判决得到字节稳定的 system 块和 provenance。
2. A/B 关闭时不注入但保留“本轮关闭”的审计。
3. 历史 Turn 的冻结判决快照在 MemOS 后续 supersede 后仍可核对。
4. 判决文本中的伪 system 指令、换行和控制字符不能逃逸数据边界。
5. 普通回答、只读 Harness 与 sources-only 既有测试全部保持。
