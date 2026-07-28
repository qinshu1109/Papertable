# TASK-010 执行日志

- WenzMark ID: `5c05ffc8-c467-492a-88d0-bc3d9f708c9e`
- 分支: `task/TASK-010-capability-gate`
- 开始时间: `2026-07-28 14:26:11 +0800`
- 状态: `in_progress`

## 执行记录

- 已确认专用分支与初始工作区；保留未跟踪的 `QA_REPORT.md`、`conversation-2026-07-27-084611.txt`、`qa-evidence/`。
- 按任务指定顺序直接读取上下文、任务/依赖记录与输出、TASK-001 spike、ADR-001/007、引用研究，以及 Web/Tauri 探测、Agent 执行/修复、设置 UI、类型、持久化/迁移和测试的完整相关路径。
- 将公开能力结果升级为 schema v1 三阶段状态：工具调用发出、工具结果回灌、流式工具调用增量；同时携带安全失败说明、适配层版本、网关结构指纹、探测/到期时间和 TTL。
- Web server 与 Rust/Tauri 都执行真实三段探测；任一阶段未通过、未执行、适配层不匹配或网关结构不匹配均显式返回 `unavailable`，不再选择 Agent 两阶段回落。普通无资料库聊天不触发该门禁。
- 新增默认 24 小时、1 分钟至 30 天可配置 TTL；到期在 Agent 准入前重探。设置页修改 TTL 会同步重算现有条目的到期时间。
- 新增以 endpoint + model + adapter 为键的并发探测协调器：同键请求共享 in-flight 探测，探测期间设置变化时丢弃旧结果，旧探测不能覆盖新设置。
- 实现并测试四个立即失效器：模型/地址变化、协议适配层版本变化、运行时 `protocol_error`、网关返回结构变化。运行时错误只对同一 endpoint/model/protocol 失效和重探，不降级。
- IndexedDB 升至 v7、SQLite `user_version` 升至 10；旧布尔/回落能力缓存直接失效，默认 TTL 写入设置。Web/Tauri 使用同一个 fail-closed 公开结果归一化器。
- 设置页新增三阶段结果、安全详情、上次探测、到期时间、TTL、重新探测状态和不可用原因；新增通过、部分失败、过期三种确定性 e2e 场景。
- 新增 TASK-013 schema-v1 replay fixtures 与任务截图：
  - `outputs/task-010/three-stage-admitted.json`
  - `outputs/task-010/three-stage-partial-failures.json`
  - `outputs/task-010/invalidation-matrix.json`
  - `outputs/task-010/stale-probe-concurrency.json`
  - `outputs/task-010/screenshots/agent-capability-gate.png`
- 截图已按原始分辨率人工复核：三阶段、时间、TTL、重探按钮完整可见，无裁切或横向溢出。
- 结束时间：`2026-07-28 15:02:27 +0800`。任务卡按合同保持 `in_progress`。

## 验证结果

- `pnpm typecheck`：通过。
- `pnpm test`：229/229 通过；覆盖 TTL、四个失效器、三阶段部分失败、无回落执行、并发去重/旧响应丢弃、网关结构变化、Web/Tauri 归一化一致、IndexedDB 迁移和 TASK-013 fixtures。
- `pnpm verify`：最终通过（typecheck、ESLint、Prettier check、229 个单元/集成测试、88 个 Rust 测试、Web production build）。首次运行发现 3 个 lint 错误（两个无效初值、一个刻意保留的 TASK-011 遗留实现未引用）；修正/明确迁移用途后重跑通过。
- `pnpm build:desktop`：通过；桌面 production bundle 成功。
- `/Users/qinshu/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml --check`：通过。
- `/Users/qinshu/.cargo/bin/cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- `/Users/qinshu/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml`：88/88 通过。
- `pnpm test:e2e`：35/35 通过（最终复跑 45.1 秒）。
- TASK-010 三个聚焦 UI 场景：3/3 通过；其中 TTL 持久化客观断言为 `43_200_000 ms`，并同步更新缓存到期差值。
- `workspace_builder.py validate --root harness-rebuild`：`ok: true`、0 errors；L2/code，13 个任务。仅报告 7 个 accepted ADR 需保留人工确认记录的治理提醒。
- `jq` fixture validation：4 个 JSON 均为 schema v1；失效矩阵 5 行、三种部分失败均 `unavailable`、并发探测数 1 且旧缓存写入数 0。
- `git diff --check`：通过。
- 格式化：仅对 TASK-010 涉及的 TS/JS/CSS/JSON/Markdown 运行 Prettier，并运行 Rust fmt；最终全库 `prettier --check .` 通过。
- 范围审计：分支仍为 `task/TASK-010-capability-gate`；暂存区为空；未 commit、push、开 PR、merge 或切分支；任务卡仍为 `in_progress`；三个用户未跟踪 QA 资产保持未跟踪且未修改。

## 发现

- `pnpm verify` 的 Web/desktop Vite build 都保留既有的大于 500 kB chunk 警告；构建成功。该优化不属于 TASK-010，未扩展范围。
- 全量 Playwright 会重新生成 TASK-009 的 tracked screenshot `outputs/task-009/screenshots/live-continuation-completed.png`。范围审计发现后已恢复为运行前内容；TASK-009 无残留变更。
- 聚焦 UI 测试最初从仍在运行的 React 页面直接写 IndexedDB，触发测试夹具与 store 持久化竞态；改为在同源 inert API 页面写入并使用真实 health endpoint/model 后稳定通过。产品代码无需为测试竞态增加入口。

## 监督验收

- `2026-07-28`：WenzMark 数据库状态为 `awaitingAcceptance`，退出码 `0`，执行进程已结束。
- 监督 Codex 直接复核能力门禁、普通无资料库聊天旁路、运行时结构变化重探、Web/Tauri 三段探测、缓存迁移与任务范围；未发现阻断问题。
- 独立复跑 `pnpm verify`：229/229 TS/Node、88/88 Rust、类型检查、lint、格式检查与生产构建全部通过。
- 独立复跑 `pnpm test:e2e`：35/35 通过；复跑生成的 TASK-009 截图已恢复，未留下卡外改动。
- 截图按原始分辨率复核通过；暂存区为空，三个用户 QA 资产保持未跟踪且未修改。技术验收通过，进入提交、PR 与 CI 阶段。
