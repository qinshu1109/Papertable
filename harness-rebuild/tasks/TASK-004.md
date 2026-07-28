---
id: TASK-004
title: 状态机重装：17条路径映射 + 3个既有bug修复
status: pending
depends_on: [TASK-001, TASK-002, TASK-003]
parallelizable: false
isolation: outputs/task-004/
merge_strategy: human-review
verify: 17条旧路径各有映射测试；K路径置位truncated；收尾失败不再丢弃readChunks；两条同文案错误分家；固定用例①预算耗尽+收尾成功→partial ②预算耗尽+收尾空响应且修复失败→failed/protocol_error（证据完整保留、无假答案）均通过
---

## 任务内容
把 runAgentTurn 重装为显式状态机（形态按 TASK-001 结论：依赖 pi 循环或自研驱动器）。所有退出路径落入 ADR-002 合法组合。修复三个既有bug：K路径truncated置位（agent.ts:749-762）；收尾调用失败时用已读证据走"就地综合"通道而非通用错误（store.tsx:1540-1563）；错误码接线（TASK-002 定义）。移植 Pi 两条不变量：工具错误一律 isError 回灌绝不 throw；stopReason=length 作废整批截断 tool_call。真实故障的两个固定回归用例在本卡落地。

## 输入
ADR-002/003；sources/research/papertable.md §1-2；TASK-001 报告。

## 预期输出
新状态机 + 全路径映射测试 + 两个故障固定用例。

## 边界
本卡不删除双阶段（仍可被旧入口调用），只保证新状态机接管原生模式。
