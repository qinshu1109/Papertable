---
id: TASK-019
title: AI 调用性能基线与分段计时
status: done
depends_on: []
parallelizable: false
isolation: outputs/task-019/
merge_strategy: human-review
verify: 不改变 Agent、工具、引用和判决语义即可重复记录 preflightMs、firstVisibleMs、totalMs；同一组 5 个真实问题形成优化前基线；性能记录不含提示词、工具参数、API 密钥、绝对路径或笔记正文；类型、存储往返、假服务延迟与全量 verify 均通过
---

## 描述

先把“点击发送后哪里在等”变成可比较的数据，再改实现。复用现有
`AgentRunTrace`、Agent 事件时间戳和 `server/fake-provider.mjs`，只补最小的三段耗时：

- `preflightMs`：用户发送到首个模型请求发出；
- `firstVisibleMs`：用户发送到首个可见正文或明确终局提示；
- `totalMs`：用户发送到本轮结束。

同一机器、同一模型、同一组 5 个真实问题在优化前后复跑。假模型增加可控延迟，用于
稳定复现“上游等待”和“UI 是否仍有心跳”，不新增遥测服务。

边界：本卡不调整工具轮次、提示词、超时、请求并发、流式策略或 UI；性能数据只能保存
耗时、计数和阶段名，不得保存用户内容、模型正文、工具入参、密钥、绝对路径或笔记正文。

执行模型必须把本文件当作实时状态面板：动手前先把 `status` 改为
`in_progress` 并写开始日志；每完成一个复选项，立即把 `[ ]` 改为 `[x]`，并在
“任务进度”追加带日期时间、结果和证据路径的一条记录，再开始下一项。测试失败、发现
阻塞或改变方案时也必须当场记录，禁止完工后批量补写。详细证据同时写入
`logs/TASK-019.md`；执行模型不得自行标记 `done`，只有监督者验收合入后可以修改。

## 任务列表

- [x] 按 AGENTS 顺序读取上下文、建立本卡分支与日志，并冻结 5 个真实问题及运行环境。
- [x] 定义三项耗时的起止事件和计时口径，避免把网络首 token 与本地首个请求混为一项。
- [x] 在现有 trace/持久化通道中加入最小可选性能字段，并覆盖 Web、Desktop 与无损包往返。
- [x] 给 `server/fake-provider.mjs` 增加测试专用的确定性延迟控制，不影响默认 E2E。
- [x] 增加数据最小化测试，证明性能记录不含提示词、工具参数、密钥、路径和笔记正文。
- [x] 在正式实现改动前跑同一组 5 个真实问题，记录各段原始值、中位数和运行条件。
- [x] 运行聚焦测试与 `pnpm verify`，把命令、结果和基线保存到 `outputs/task-019/`。

## 任务进度

- 2026-07-29：任务卡已创建，尚未开始；等待监督者在不干扰 TASK-018 真实事件门的时机启动。
- 2026-07-29T17:23:24+08:00：状态改为 `in_progress`；直接切换分支因主工作树已有共享文件修改被 Git 安全阻止，未覆盖或暂存用户改动，改用从 `41c915e` 建立的独立 worktree `/tmp/papertable-task019`；详见 `logs/TASK-019.md`。
- 2026-07-29T17:29:00+08:00：已按 AGENTS 顺序完成上下文读取、分支/日志建立，并冻结 q1～q5 与软硬件/模型运行条件；证据见 `outputs/task-019/frozen-questions.json`、`environment.json`。
- 2026-07-29T17:31:00+08:00：冻结 `send → first-model-request / first-visible / finished` 口径，明确本地请求发出不等于网络首 token；证据见 `outputs/task-019/timing-contract.md`。
- 2026-07-29T17:36:00+08:00：正式实现改动前已用真实 `claude-opus-5` 串行完成同组 5 题，三段中位数为 `1 / 36516 / 36516 ms`；性能结果只含案例 ID、耗时、计数、模型与终局，证据见 `outputs/task-019/pre-implementation-baseline.json`。
- 2026-07-29T17:37:00+08:00：首轮聚焦测试 76/77 通过；唯一失败是延迟测试直接拼接 `Uint8Array` 得到数字串，事件本身与 250ms 注入均已产生。方案不变，改为按 SSE 字节解码后复跑；详见 `logs/TASK-019.md`。
- 2026-07-29T17:38:00+08:00：解码修正后 Node/TS 聚焦测试 77/77 通过；直接调用 `cargo` 因 PATH 缺失返回 127，按仓库既有回退使用固定 Rust 工具链路径复跑，未改变实现。
- 2026-07-29T17:39:00+08:00：`AgentRunTrace.performance` 已通过共享 Store/Agent 接缝记录三段耗时，Web Dexie、Desktop SQLite、无损包往返均通过；证据为 `agentPerformance.test.ts`、`dexie.test.ts`、`db.rs`、`formats.test.ts`。
- 2026-07-29T17:39:00+08:00：假服务支持仅测试环境启用的 `PAPERTABLE_FAKE_LLM_DELAY_MS`，默认 0、非法值归零、上限 60000ms；聚焦测试证明默认 E2E 行为不变。
- 2026-07-29T17:39:00+08:00：数据最小化白名单测试通过，性能对象只允许 `preflightMs`、`firstVisibleMs`、`totalMs` 三个数值字段，不接收或传播提示词、工具参数、密钥、绝对路径和笔记正文。
- 2026-07-29T17:41:00+08:00：首次 `pnpm verify` 在 ESLint 停止，原因为基线 runner 的 `_event` 参数未使用；生产代码和测试未失败，删除无用参数/类型导入后从头复跑。
- 2026-07-29T17:43:00+08:00：候选验收门全部通过：`pnpm verify`（232 Node/TS/server、94 Rust、Web build）、默认 E2E 36/36、500ms 延迟场景 1/1、Desktop build、Rust fmt/clippy 与 `git diff --check`；命令、失败修正和基线汇总见 `outputs/task-019/verification.md`。本卡保持 `in_progress`，等待监督者验收。
- 2026-07-29T17:57:12+08:00：监督者独立复核通过并合入 PR #19（merge `19b1c86`）；本地 `pnpm verify`、36/36 Playwright、Desktop build、严格 clippy/fmt 全绿，远端 `verify` 与 `rust` 亦通过，本卡标记 `done`。
