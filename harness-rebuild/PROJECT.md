# PROJECT

## 目标

把 Papertable 的 Agent Loop 从"if/return/catch 拼接、能跑但死因不明"重装为：显式状态机（结果×原因两轴）、预算产品化、过程事件溯源持久化、协议同轨修复、探测准入门禁、拖放附件生命周期。

后续阶段：以外接 MemOS 的判决簿保存用户确认的墓碑与金子，并把相关判决冻结注入新的干净上下文。

## 背景

真实故障：模型连续多轮工具调用后收尾空响应，被笼统报为"模型没有返回文本"。代码分析见 sources/research/papertable.md（17条退出路径穷举）。

## 交付物

TASK-001～013 已完成。判决簿按 TASK-014～018 施工，以 TASK-018 的事件门收口。

## 约束

- 只支持云端旗舰原生工具模式，禁止任何形式降级（ADR-001）
- 只读边界七层与引用治理是不可触碰资产
- 模型工作集与完整审计历史分离（ADR-006）

## 入口

- 决策：DECISIONS.md
- 任务：tasks/README.md 与 ORCHESTRATION.md
- 研究依据：sources/research/
