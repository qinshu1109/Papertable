# tasks

13 张卡，权威依赖图见 [ORCHESTRATION.md](../ORCHESTRATION.md)。

## 状态

- `pending`：依赖或门禁未满足。
- `in_progress`：WenzMark 正在执行，或已到 `awaitingAcceptance` 等待监督验收。
- `done`：监督 Codex 独立复跑、PR CI 和合入均完成。
- `blocked`：两轮分类修复仍失败，或触发范围/权限/冲突护栏。

执行 Agent 不得自行设置 `done`。每卡一个 WenzMark 会话、分支、PR 和 `logs/TASK-xxx.md`；监督者完成技术验收并统一回写共享状态。用户已预授权全部卡片与 TASK-011 删除，不再设置人工停顿门禁。
