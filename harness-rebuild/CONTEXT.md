---
workspace_schema: 2
level: L2
profile: code
---

# CONTEXT

本工作区管理 Papertable Agent 发动机重装（分支 feat/readonly-note-harness-alpha）。

## 读取顺序

1. 本文件 → CURRENT.md → PROJECT.md
2. 当前任务卡（tasks/TASK-xxx.md）
3. 该卡引用的 ADR（decisions/）
4. 需要时查 sources/research/ 四份代码分析报告

## 规则摘要

- accepted ADR 是硬约束；当前 ADR 均待用户确认
- 每次 Codex 运行只执行一张任务卡
- 测试与实现同卡交付，不得延后
- 编排与依赖图见 ORCHESTRATION.md
