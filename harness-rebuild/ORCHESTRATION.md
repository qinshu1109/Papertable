# ORCHESTRATION

## 模式

orchestration_mode: single-thread。默认逐卡执行；`parallelizable` 只表示具备隔离 worktree 时允许并行，不表示自动放行。

## 依赖图

```
TASK-001（Pi spike，必须先行）
TASK-002 → TASK-003
TASK-001 + TASK-002 + TASK-003 → TASK-004
TASK-004 → TASK-005 → TASK-008 → TASK-009
TASK-004 → TASK-006
TASK-004 → TASK-007 → TASK-010
TASK-003 → TASK-012
TASK-004~010 全绿 + 用户确认 → TASK-011
TASK-011 + TASK-012 → TASK-013
```

## 拆分规则

- 每卡一个分支一个 PR，merge_strategy=human-review（用户验收）。
- 卡内发现的卡外问题：写入卡内"发现"小节或 memories/candidates/，不扩散改动。
- TASK-011 是唯一的删除类卡，开工前必须用户确认；之前所有失败路径必须已有新状态机承接（避免中间版本"一失败就什么都没有"）。
- 并行卡必须使用独立 Git worktree，并分别把 WenzMark 工作路径指向对应 worktree；共享工作副本禁止并发写。

## WenzMark

- 每次只创建一张已解锁任务卡；工作路径必须是 Papertable 仓库或该卡的独立 worktree。
- 使用自定义提示词引导读取 CONTEXT → CURRENT → PROJECT → AGENTS → 当前卡 → 相关 ADR/资料。
- Goal 模式关闭，执行方式串行，立即执行关闭；verify 与 human-review 通过后才创建下一卡。
- WenzMark Workflow 不解析 `depends_on`，也不提供卡间人工验收门禁，禁止用一个 Workflow 自动跑完 13 卡。

## 成本护栏

单卡运行超过预估 2 倍时间或需要重构卡外模块时，停下来汇报，不自行扩权。
