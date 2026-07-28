# AGENTS — Codex 执行守则

## 每次运行

1. 先读 CONTEXT.md → CURRENT.md → 本卡 → 本卡 depends_on 各卡的"预期输出"与实际产物 → 本卡引用的 ADR。
2. 确认本卡已解锁，从最新已验收的 `feat/readonly-note-harness-alpha` 建立专用分支；TASK-012 必须使用独立 worktree。
3. 启动时由执行 Agent 把本卡改为 `in_progress`，并写 `logs/TASK-xxx.md` 的 WenzMark ID、分支和开始时间。
4. 只执行当前一张任务卡。卡外问题记入卡内"发现"或 memories/candidates/，不顺手修。
5. 实现与测试同卡交付；verify 全绿后记录候选完成结果，但执行 Agent 不得自行把本卡改为 `done`。
6. Codex 监督者独立验收、提交、推送、审查和合并；合入后才把任务改为 `done`，并统一回写 CURRENT 与日志。
7. 每卡一个 WenzMark 会话、分支和 PR；commit message 引用 TASK-id。

## 硬约束（违反即返工）

- ADR-001~007 已由用户统一确认，均为 accepted 不变量。
- 不得删除或绕过只读边界与引用清洗逻辑（controlledCitations、readableIds 及七层强制）。
- 删除类改动只允许出现在 TASK-011。
- 不得让子 Agent 的摘要替代你直接阅读 src/lib/agent.ts、src-tauri/src/llm.rs、src/store.tsx 的相关段落。
- 协议修复只允许确定性操作；有歧义一律要求模型重发，不得猜测或伪造（ADR-007）。

## 上下文纪律

- 不要加载全部历史。研究报告按需查阅对应小节。
- 发给模型的续跑工作集构成以 ADR-006 为准。
- 前置上下文由工作区文件和依赖卡产物承载，不依赖跨卡聊天记忆。
- WenzMark 仅作任务启动器；其状态、自述或退出码都不能替代 verify 和监督验收。

## 状态与写入归属

- 任务卡：`pending → in_progress → done | blocked`；WenzMark 的 `awaitingAcceptance` 只记录在对应日志。
- 执行 Agent 只写本卡、隔离产物和本卡日志；共享 CURRENT、验收结论与 `done` 由监督者单写。
- 卡外共享文件冲突、耗时超过预估两倍或需要扩大范围时，执行 Agent 停止写入并记录证据；监督者直接分类修复、重排后继续，不再请求用户授权。
- 用户已预授权本项目全部卡片、PR/合并及 TASK-011 删除门禁；持续目标只在 TASK-013 最终验收通过后结束。
