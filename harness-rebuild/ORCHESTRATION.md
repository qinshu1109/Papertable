# ORCHESTRATION

## 模式

`orchestration_mode: single-thread`。旗舰模型在同一状态机与事件 schema 上持续施工，主干严格单写者串行；`parallelizable` 不代表自动放行。

## 固定泳道

```
主泳道：
TASK-001 验收 → TASK-002 → TASK-003 → TASK-004 → TASK-005 → TASK-006
→ TASK-007 → TASK-008 → TASK-009 → TASK-010 → 用户确认 → TASK-011 → TASK-013

条件泳道：
TASK-003 合入 → TASK-012 文件重叠预检 → 独立 worktree 并行或回退主泳道
```

TASK-013 必须同时等待 TASK-011 与 TASK-012。TASK-001 已完成；任何下一卡都从最新已验收的集成分支建立。

## TASK-012 放行条件

TASK-003 合入后先做只读文件重叠预检。只有附件线不修改状态机、事件 schema、`readableIds` Rust 数据层校验及主泳道共享热点时才开第二泳道；否则自动回退串行。放行时必须使用独立 worktree，WenzMark 工作路径指向该 worktree，禁止共享工作副本并发写。

## 每卡 WenzMark 设置

- 模型固定 `gpt-5.6-sol`，推理固定 `high`；一次定向修复仍失败时，才以 `xhigh` 重跑。
- Goal 模式关闭；串行开关关闭；立即执行关闭。
- 每次只创建一张已解锁任务卡，不建立自动跑完 13 卡的 Workflow。
- 工作路径必须是该卡分支所在仓库；TASK-012 使用独立 worktree。
- 使用自定义提示词引导读取 CONTEXT → CURRENT → PROJECT → AGENTS → 当前卡 → 相关 ADR/资料。
- WenzMark 到 `awaitingAcceptance` 后停止接力；监督验收和 PR 合入后才在 WenzMark 验收并创建下一卡。

## 状态与进度

- 任务卡：`pending → in_progress → done | blocked`。执行 Agent 不得认定 `done`。
- `CURRENT.md`：当前卡、下一卡、阻塞项、最近验收，保持 500 字预算。
- `tasks/TASK-xxx.md`：权威任务状态与客观 verify。
- `logs/TASK-xxx.md`：WenzMark ID、分支、时间、检查点、测试、异常和验收结论。
- WenzMark 数据库、进程、日志或 Git 状态不一致时，以证据对账并修正状态，不盲目重跑。

## 监督验收与 Git

每卡同时核对：

1. WenzMark 数据库、日志、进程与退出码；
2. Git diff、分支与文件范围；
3. 任务 verify、实际产物与监督者独立复跑。

通过后由监督 Codex 使用明确 pathspec 提交，推送并创建 PR；CI 与独立审查通过后合入 `feat/readonly-note-harness-alpha`，再关闭 WenzMark 验收。禁止 `git add .`，禁止纳入无关未跟踪文件。

## 故障兜底

- Verify 或 CI 失败：保留证据，在同一分支创建一次定向修复会话；按错误类别最多两轮，重复失败则 `blocked`。
- 偶发测试只复跑一次；不能稳定通过则不验收。
- 进程已结束但 UI 仍显示运行时，只校正状态。
- 卡外改动、共享热点冲突、耗时超过预估两倍或需要扩大权限时停止接力。
- TASK-004 起每卡在自身 isolation 保存关键事件流 fixture；TASK-013 统一回放。
- TASK-003/008 验收崩溃恢复；TASK-009/010/012 留 UI 与截图证据；TASK-004/011/013 跑全量回归。

## 人工门禁

- ADR-001~007 只有用户一次性确认后才能由 `proposed` 改为 `accepted`。
- TASK-011 是唯一删除卡；TASK-004~010 全绿后仍须取得用户即时确认才开工。
- 其余技术验收、返工判断与 PR 合入由监督 Codex 负责。
