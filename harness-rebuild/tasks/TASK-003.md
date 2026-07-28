---
id: TASK-003
title: 事件溯源持久化：schema 与写入路径
status: pending
depends_on: [TASK-002]
parallelizable: false
isolation: outputs/task-003/
merge_strategy: human-review
verify: 事件表落地且带 schema_version；崩溃注入测试通过（任意步骤后 kill，重启可读到最后完整步骤，无半条记录）；旧 turn 以 legacy 只读呈现；事件写入与状态变更同事务
---

## 任务内容
按 ADR-006 建 agent_runs / agent_events 表与写入通道。事件类型：探索开始、请求搜索、搜索完成、请求读取、读取完成、重复调用发现、协议修复、重试、预算追加、最终综合、终态。步骤级，不存逐token。实现 AgentMessage（完整审计）与 convertToLlm（工作集）的结构分离（本卡先落审计侧）。

## 输入
ADR-006；现有 schema.sql 与 turns.agent_run 摘要trace。

## 预期输出
迁移脚本 + 写入API + 崩溃注入测试。
