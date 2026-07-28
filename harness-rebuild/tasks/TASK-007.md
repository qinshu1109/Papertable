---
id: TASK-007
title: 协议修复管线（同模型同协议）
status: pending
depends_on: [TASK-004]
parallelizable: true
isolation: outputs/task-007/
merge_strategy: human-review
verify: 分类表测试逐项通过（401不重试/429退避/5xx与空响应≤2次/畸形参数→清洗重组→要求重发）；修复链条尽头才是 protocol_error 且证据轨迹完整；删除H路径宿主词法兜底的调用（代码删除留给TASK-011）；所有修复动作出现在事件流
---

## 任务内容

按 ADR-007 实现分类修复管线：确定性清洗（NFKC/零宽/全角标签，参考 openhanako sanitizer 模式但不搬运行时）→无损流式参数重组→要求同一模型重发合法调用→重建流或同协议非流式→能力缓存失效重新握手→最后稳定步骤重试。空工具名/破碎参数：只检测与确定性修复，禁止猜名、伪造token、假装成功。

## 输入

ADR-007；llm.rs:1030；http.ts。

## 预期输出

修复管线 + 分类重试策略表 + 假provider注入测试。
