---
id: TASK-002
title: 终态类型层：结果×原因 + 合法组合表
status: in_progress
depends_on: []
parallelizable: true
isolation: outputs/task-002/
merge_strategy: human-review
verify: 类型与组合表合入；非法组合被类型或测试拒绝；单测覆盖全部合法组合与至少5个非法组合；不改动现有运行逻辑
---

## 任务内容

按 ADR-002 定义 AgentRunResult（completed|partial|refused|failed|aborted）与 StopReason 两轴类型、合法组合表、以及面向 UI 的用户可读文案映射。把现有"模型没有返回文本"两处同文案（llm.rs:338/http.ts:42 与 store.tsx:1509）拆分为不同错误码（本卡只定义错误码，接线在 TASK-004）。纯类型+测试，不接入循环。

## 输入

ADR-002、ADR-003；sources/research/papertable.md §2.1 的17条路径表。

## 预期输出

类型模块 + 组合表文档注释 + 测试。
