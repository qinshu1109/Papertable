---
id: TASK-011
title: 删除双阶段与全部旧兜底
status: in_progress
depends_on: [TASK-004, TASK-005, TASK-006, TASK-007, TASK-008, TASK-009, TASK-010]
parallelizable: false
isolation: outputs/task-011/
merge_strategy: human-review
verify: runTwoStage/planQueries/宿主词法兜底代码删除，全量回归绿；验收矩阵断言协议失败时无静默双阶段行为；删除前后包体与死代码对比记录在案
---

## 任务内容

唯一的删除卡。用户已预授权；仅在所有失败路径已被新状态机承接（TASK-004~010 done）后开工。删除 runTwoStage、planQueries、H路径及其调用点与探测回落逻辑；不保留内部 eval 基线。

## 输入

ADR-001；全部前置卡产物。

## 预期输出

删除 PR + 回归证明。
