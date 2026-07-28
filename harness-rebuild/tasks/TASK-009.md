---
id: TASK-009
title: 前端过程时间线与终态展示
status: pending
depends_on: [TASK-004, TASK-008]
parallelizable: true
isolation: outputs/task-009/
merge_strategy: human-review
verify: 时间线实时消费事件流（搜索→命中数→读取…）；partial/truncated/修复重试对用户可见；轨迹节点可展开、可查看底层来源、可提升为卡片；轨迹节点不可被引用为事实来源（UI与数据层均无此入口）
---

## 任务内容
用 TASK-003 的事件流渲染探索时间线；终态按 TASK-002 文案映射展示"结果+原因+预算态"；"继续深挖"按钮接 TASK-008。轨迹节点提升为卡片时建立显式继承关系，但按 ADR-004 不授予引用资格。

## 输入
ADR-002/004/006；现有 onPhase 展示（sources/research/papertable.md §3.4）。

## 预期输出
时间线组件 + 终态横幅 + 节点提升交互。
