---
id: TASK-001
title: 任务标题
status: pending
depends_on: []
parallelizable: true
isolation: outputs/task-001/
merge_strategy: direct
verify: 待补充
---

## 任务内容

待补充。

## 输入

待补充。

## 预期输出

待补充。

## 执行记录

WenzMark ID、分支、时间、检查点、测试和验收结论写入 `logs/<id>.md`。执行 Agent 只可将 `pending` 改为 `in_progress`；监督 Codex 在独立验收并合入 PR 后设置 `done`，两轮分类修复仍失败时设置 `blocked`。
