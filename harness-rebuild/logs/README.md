# logs

每张卡使用 `TASK-xxx.md`，至少记录：

- WenzMark ID、模型/推理、分支/worktree、开始与结束时间；
- 数据库状态、日志、进程和退出码对账；
- Git 文件范围、检查点、verify 与监督者独立复跑；
- 异常、定向修复轮次、PR/CI/合并和最终验收。

执行 Agent 可追加运行证据，不可写最终 `done`。监督 Codex 负责验收结论与共享状态。临时故障另建 repair 日志并从任务日志链接。
