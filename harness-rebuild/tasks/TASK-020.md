---
id: TASK-020
title: Desktop 阻塞命令异步化与 HTTP 连接复用
status: in_progress
depends_on: [TASK-019]
parallelizable: true
isolation: outputs/task-020/
merge_strategy: human-review
verify: 所有包含阻塞 HTTP 或可变时长检索的生成路径 Tauri 命令均在 blocking 线程池执行；本地 5 秒延迟期间窗口可拖动、卡片可切换且 UI 心跳最大间隔不超过 250ms；LLM 与 MemOS 连续请求复用连接池而保持每次 MCP 会话独立；返回值、错误、取消、超时、只读边界及全量 Web/Rust/E2E 门禁无回归
---

## 描述

修复 Desktop 的“窗口真冻结”和重复握手。当前 `src-tauri/src/lib.rs` 中只有
`llm_stream` 已使用 `async fn + spawn_blocking`；`provider_health`、
`llm_generate`、`llm_complete`、`provider_probe_capability` 和 `verdict_*`
仍直接执行阻塞 HTTP，资料库/附件的 `search`、`read` 也可能长时间占用命令执行线程。

本卡沿用 `llm_stream` 的既有做法，只把阻塞工作搬到
`tauri::async_runtime::spawn_blocking`。`src-tauri/src/llm.rs` 与
`src-tauri/src/memos.rs` 使用标准库 `OnceLock<ureq::Agent>` 复用连接池；
MemOS 每次逻辑调用仍重新执行 MCP initialize 并使用独立 session。

边界：不引入 `reqwest` 或新依赖，不改前端调用语义、超时值、重试、取消、工具 schema、
资料库 scope、`readableIds` 或引用资格；短小且确定性的纯本地命令不为追求形式统一而
改写。

执行模型必须实时回写本卡：开始前修改状态并记日志；每完成一个复选项立刻勾选并在
“任务进度”追加日期时间、结果与证据；测试失败、阻塞、范围变化也要立即记录，禁止
最后一次性补写。详细命令与原始结果写入 `logs/TASK-020.md`；执行模型不得自行标记
`done`。

## 任务列表

- [ ] 读取 TASK-019 基线和相关 Rust 调用链，建立本卡分支、日志与阻塞命令清单。
- [ ] 将 `provider_health`、`llm_generate`、`llm_complete`、`provider_probe_capability` 改为异步命令，并把阻塞工作移入线程池。
- [ ] 将 `verdict_health/ensure_cube/list/confirm/supersede` 改为异步命令，保持不可用态、幂等和 supersede-only 语义。
- [ ] 将资料库与附件的生成路径 `search/read` 移出同步命令路径，保持数据库连接和 run 级 allowlist 边界。
- [ ] 为 LLM 建立共享 `ureq::Agent`，验证连续请求复用 DNS/TCP/TLS 连接。
- [ ] 为 MemOS 建立共享 `ureq::Agent`，验证连接池复用且不同工具调用不会复用旧 MCP session。
- [ ] 用 TASK-019 的 5 秒假延迟测窗口拖动、卡片切换和 UI 心跳间隔，并对比三段耗时。
- [ ] 运行 Rust 聚焦测试、严格 clippy、`pnpm verify` 与 Desktop E2E，把证据保存到 `outputs/task-020/`。

## 任务进度

- 2026-07-29：任务卡已创建，尚未开始；TASK-019 验收后解锁，可与 TASK-021 独立 worktree 并行。
- 2026-07-29T18:00:08+08:00：TASK-019 已通过 PR #19 与远端 CI 验收，本卡从基线 `7136b97` 建立专用分支 `task/TASK-020-desktop-async-http-reuse` 并改为 `in_progress`；启动证据见 `logs/TASK-020.md`。
- 2026-07-29T18:01:13+08:00：首次调用链扫描发现基线 `7136b97` 不含任务明确要求的 `memos.rs` 与 `verdict_*`；相关实现位于 `a57e880` 的 TASK-014～018 汇总候选。已暂停代码修改并记录基线范围阻塞，先核对现有集成分支后再继续，详见日志。
