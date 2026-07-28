---
id: TASK-006
title: 无进展检测
status: done
depends_on: [TASK-004]
parallelizable: true
isolation: outputs/task-006/
merge_strategy: human-review
verify: 注入测试通过：同签名首次重复→注入一次提醒；再次重复→停止；证据足够→同模型未完成综合(partial/no_progress)；证据不足→明确"无进展"而非笼统错误；重复发现事件落盘
---

## 任务内容

对成功工具调用做签名去重（name+归一化args哈希）。首次重复注入系统提醒"该查询已执行过、结果无变化"；再次重复停止烧预算，按证据充分性走 ADR-004 的部分答案或无进展声明。替换只统计异常的 failures Map 语义（保留其对异常的熔断）。

## 输入

ADR-002/004；agent.ts:439-450。

## 预期输出

签名去重模块 + 提醒注入 + 测试。
