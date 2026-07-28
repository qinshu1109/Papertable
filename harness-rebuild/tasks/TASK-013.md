---
id: TASK-013
title: 金样回放与真实模型验收矩阵（持续建设，最终门禁）
status: pending
depends_on: [TASK-011, TASK-012]
parallelizable: false
isolation: outputs/task-013/
merge_strategy: human-review
verify: 金样事件流fixtures可回放且语义变更会报警；真实模型矩阵脚本对每个场景只断言六项：调用了正确工具/落在正确终态/证据已保存/无越权读取/无未处理重复调用/协议失败时无双阶段行为；两个故障固定用例在矩阵中分别断言 partial 与 protocol_error
---

## 任务内容

fixtures 随 TASK-004 起持续沉淀（每卡把关键事件流存为金样），本卡收口：回放器 + 真实旗舰模型验收矩阵（自然收敛/预算耗尽/无进展诱饵/附件引用/协议故障注入 × 目标模型列表）。不比较答案措辞。

## 输入

ADR 全部；各卡金样。

## 预期输出

回放测试 + 验收脚本 + 发布门禁文档。
