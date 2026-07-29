# tasks

18 张卡，权威依赖图见 [ORCHESTRATION.md](../ORCHESTRATION.md)。

- TASK-001～013：Harness 重建，已完成。
- TASK-014～017：判决簿主链，监督技术验收通过，待统一提交、PR 与合入。
- TASK-018：实现与确定性门禁通过，真实 A/B/改道事件门仍在进行。原始决策见
  [INPUT-20260729-001](../sources/INPUT-20260729-001.md)。

## 状态

- `pending`：依赖或门禁未满足。
- `in_progress`：WenzMark 正在执行，或已到 `awaitingAcceptance` 等待监督验收。
- `done`：监督 Codex 独立复跑、PR CI 和合入均完成。
- `blocked`：两轮分类修复仍失败，或触发范围/权限/冲突护栏。

执行 Agent 不得自行设置 `done`。每卡一个 WenzMark 会话、分支、PR 和
`logs/TASK-xxx.md`；监督者完成技术验收并统一回写共享状态。TASK-001～013
沿用原授权记录；判决簿候选当前集中在同一工作分支，尚未提交/PR/合入，因此任务卡
保持 `in_progress`。
