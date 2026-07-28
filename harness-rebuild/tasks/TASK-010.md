---
id: TASK-010
title: 探测升格为准入门禁
status: in_progress
depends_on: [TASK-007]
parallelizable: true
isolation: outputs/task-010/
merge_strategy: human-review
verify: 探测失败时UI显示三段（工具调用/结果回灌/流式delta）各自通过与否、上次探测时间、是否重探中；四个失效触发器各有测试（模型或地址变化/协议适配层升级/运行中protocol_error/网关返回结构变化）；TTL初始24h可配置；无任何回落路径
---

## 任务内容

保留三段真实握手（llm.rs:1114），把"失败→two-stage"改为"失败→该模型不可用于Agent模式"的显式状态与UI说明。能力缓存加TTL与四个立即失效触发器；运行中 protocol_error 由 TASK-007 管线触发缓存失效与重新握手。

## 输入

ADR-001/007；store.tsx:1005-1054。

## 预期输出

门禁状态 + 缓存失效器 + UI。
