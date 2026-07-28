# AGENTS — Codex 执行守则

## 每次运行

1. 先读 CONTEXT.md → CURRENT.md → 本卡 → 本卡 depends_on 各卡的"预期输出"与实际产物 → 本卡引用的 ADR。
2. 只执行当前一张任务卡。卡外的问题记入卡内"发现"小节或 memories/candidates/，不顺手修。
3. 实现与测试同卡交付；verify 判据全部满足才能把 status 改为 done。
4. 完成后更新：本卡 status、CURRENT.md（三行以内）、若有新经验写 memories/candidates/。
5. 每卡一个分支与 PR，commit message 引用 TASK-id。

## 硬约束（违反即返工）

- accepted ADR 才是不变量；当前 ADR-001~007 为 proposed，涉及实施前先核对状态。
- 不得删除或绕过只读边界与引用清洗逻辑（controlledCitations、readableIds 及七层强制）。
- 删除类改动只允许出现在 TASK-011。
- 不得让子 Agent 的摘要替代你直接阅读 src/lib/agent.ts、src-tauri/src/llm.rs、src/store.tsx 的相关段落。
- 协议修复只允许确定性操作；有歧义一律要求模型重发，不得猜测或伪造（ADR-007）。

## 上下文纪律

- 不要加载全部历史。研究报告按需查阅对应小节。
- 发给模型的续跑工作集构成以 ADR-006 为准。
- WenzMark 仅作任务启动器，不把进程退出码当作 verify 或人工验收。
