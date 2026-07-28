---
id: TASK-008
title: 续跑与"继续深挖"
status: pending
depends_on: [TASK-003, TASK-005]
parallelizable: false
isolation: outputs/task-008/
merge_strategy: human-review
verify: e2e通过：预算耗尽→partial→用户追加预算→同一run从最后完整步骤继续；断言续跑prompt仅含ADR-006规定的七类内容；崩溃后续跑等价通过；recoverInterruptedTurns 泛化
---

## 任务内容

实现 run 级续跑：预算追加事件驱动同一探索继续，不新建无关问题。构建 convertToLlm 工作集压缩（用户目标/去重搜索/已读原文/已确认引用/未解决问题/停止原因/新增预算），完整历史仅存盘。中止路径落盘部分轨迹（修 store.tsx:1505 丢弃行为）。

## 输入

ADR-006；TASK-003 事件流；TASK-005 预算对象。

## 预期输出

续跑API + 工作集组装器 + e2e测试。
