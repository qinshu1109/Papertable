---
id: TASK-005
title: 预算账本对象化与产品化
status: done
depends_on: [TASK-004]
parallelizable: true
isolation: outputs/task-005/
merge_strategy: human-review
verify: 预算对象（总额/已用/剩余/耗尽原因/追加记录）随 run 持久化并可在事件流中审计；四维（轮/调用/墙钟/token）各有耗尽测试；硬编码常量全部收敛到预算对象
---

## 任务内容

把 MAX_TOOL_ROUNDS/MAX_TOOL_CALLS/MAX_WALL_MS 收敛为随 run 持久化的预算账本，新增 token 维度（从 API usage 统计）。耗尽→按 ADR-003 进入综合或报错。预算追加作为事件记录（消费在 TASK-008）。

## 输入

ADR-002/003/006；agent.ts:14-18。

## 预期输出

预算模块 + 持久化 + 测试。
