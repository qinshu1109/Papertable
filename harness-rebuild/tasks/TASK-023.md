---
id: TASK-023
title: 能力探测优化与真实 Desktop 总验收
status: in_progress
depends_on: [TASK-020, TASK-022]
parallelizable: false
isolation: outputs/task-023/
merge_strategy: human-review
verify: 共享连接后的三段能力探测有逐阶段耗时；工具调用发出与工具结果回灌保持依赖链，独立的流式工具增量探测可并发并在设置页显示阶段进度；同一组 5 个真实问题的 preflight、首个可见反馈和总耗时较 TASK-019 基线改善；10 个资料问题仍完成必要检索、阅读和受控引用且无固定工具调用上限；全量 Web/Rust/E2E、真实旗舰模型、Desktop 安装候选与窗口响应门禁通过
---

## 描述

在前四卡合流后处理剩余的能力探测等待，并完成一次真实 Desktop 总验收。普通设置页
“测试连接”只调用 `provider_health`，其窗口冻结由 TASK-020 解决；三段原生工具探测是
独立的 Agent 准入动作，不再把两者混为同一条性能数据。

先测共享连接后的三个阶段。阶段 1“工具调用发出”与阶段 2“工具结果回灌”必须串行；
阶段 3“流式工具调用增量”与前两阶段无数据依赖，可以同时启动，总耗时应接近
`max(阶段1+阶段2, 阶段3)`。复用 Tauri `Channel` 向“立即重新探测”界面发送阶段开始/
通过/失败，不传原始回复、工具参数、密钥或推理内容。现有 90/90/45 秒超时先保持，
只有真实分段数据证明超时本身不合理时才在本卡记录证据后调整。

最终验收使用 TASK-019 冻结的 5 个问题比较性能，再用 10 个真实资料问题核对模型仍能
按需多轮检索、阅读和引用。必要工具调用不设置固定 4 轮、8 次等硬上限。

边界：不引入辅助小模型、判决 TTL 缓存、`reqwest` 重写、探索转写展示、持久化正文
回滚或固定工具调用上限；不以假模型结果代替真实旗舰模型与安装版交互。

执行模型必须实时回写本卡：启动、每个复选项完成、每轮真实验收、失败、阻塞和修复都
立即更新复选框与“任务进度”，写明日期时间、结果、样本数和证据路径，禁止最后批量
补写。完整命令与原始矩阵写入 `logs/TASK-023.md`；只有监督者完成复核、提交、推送、
安装验证与合入后才可标记 `done`，执行模型不得自行标记。

## 任务列表

- [x] 读取 TASK-019～022 的实际产物与基线，建立集成分支、日志和验收矩阵。
- [x] 给三段能力探测补分阶段计时，先记录共享连接后的串行现状。
- [x] 保持阶段 1→2 依赖链，同时并发阶段 3，并覆盖成功、阶段失败、超时和线程回收。
- [x] 通过 Tauri Channel 实时更新“立即重新探测”的三阶段状态，保持普通“测试连接”语义独立。
- [x] 用同一组 5 个真实问题对比 TASK-019 基线，记录 `preflightMs`、`firstVisibleMs`、`totalMs` 与主线程心跳。
- [x] 用 10 个真实资料问题验收必要工具调用、实际 read、`readableIds`、受控引用和无固定调用上限。
- [x] 运行 `pnpm verify`、`pnpm test:e2e`、Rust 测试与严格 clippy，并完成真实旗舰模型回归。
- [x] 构建并安装 Desktop 候选，核对版本/commit、连接测试、能力探测、窗口响应和流式预览。
- [x] 将完整前后对比、失败样本、截图和发布结论保存到 `outputs/task-023/`，交监督者独立验收。

## 任务进度

- 2026-07-29：任务卡已创建，尚未开始；必须等待 TASK-020 与 TASK-022 全部通过。
- 2026-07-29T20:12:47+08:00：TASK-020、TASK-021、TASK-022 已分别通过独立本地复核与远端 CI，并经 PR #20、#21、#22 合入组合基线 `f8b84bf`；本卡从该基线建立分支 `task/TASK-023-capability-final-acceptance` 与独立 worktree `/private/tmp/papertable-task023`，状态改为 `in_progress`，启动证据见 `logs/TASK-023.md`。
- 2026-07-29T20:16:15+08:00：已直读 TASK-019～022 卡片、日志、实现与全部相关产物，冻结组合验收矩阵和 10 个真实资料问题；现有串行能力探测在同一 300ms loopback provider 上三次总耗时为 `990/926/923ms`、中位数 `926ms`，证据见 `outputs/task-023/acceptance-matrix.md`、`capability-serial-baseline.json` 与 `real-material-questions.json`。
- 2026-07-29T20:29:28+08:00：三阶段最终结果已补 `durationMs`；原生实现保持阶段 1→2 串行，并用 scoped worker 与阶段 3 并行，命令返回前必定 join。Web 同构端保留非流式 `90s/90s`、流式 `45s` 分段超时。定向 Node 集成测试（3/3）、Provider/缓存测试（15/15）和 Rust LLM 测试（21/21）通过，覆盖并行起点、依赖顺序、成功、分阶段失败/超时安全映射、异常 worker 回收与进度载荷白名单；完整命令见 `logs/TASK-023.md`。
- 2026-07-29T20:31:03+08:00：Tauri command 与设置页已接通阶段开始/通过/失败 Channel，最终状态显示阶段毫秒数；定向 Playwright 1/1 通过，并断言普通“测试连接”不会触发能力端点、手动“立即重新探测”只触发一次能力端点。
- 2026-07-29T20:34:24+08:00：全量静态/单元/构建与 UI 回归已通过：`pnpm verify`（TypeScript/ESLint/Prettier、275/275 Node/TS、102/102 Rust，1 个既有外部 MemOS 测试按设计忽略、生产构建成功）、Playwright 44/44、Rust fmt 与严格 Clippy `-D warnings`。首轮 verify 暴露并修复一个未使用参数 lint 与五个新增证据文件格式问题；修复后从头复跑通过。
- 2026-07-29T20:42:44+08:00：真实旗舰首轮在问题执行前正确关闭准入：阶段 1/3 通过，阶段 2 连续四次收到安全映射后的 HTTP 400。最小直连矩阵确认当前推理网关要求工具回灌前的 assistant 工具调用消息携带非空 `reasoning_content`，但不要求真实推理；已在 Web/Rust 上行适配层加入固定 `tool-call-continuation` 协议占位，绝不复制模型推理，并将适配版本升级为 v2 以失效旧缓存。定向 18/18 Node/TS 与 1/1 Rust 测试通过，准备重跑真实准入与问题矩阵。
- 2026-07-29T20:51:49+08:00：真实 q1～q10 结构矩阵全部完成：123 个 Markdown、913 个真实切块；每题均有 search、实际 read、合法 `readableIds` 和 1～5 个受控引用，全部 completed。q3 使用 8 次工具/9 次模型请求仍完成，证明 Desktop 运行未启用旧固定 4 轮/8 次终止。人工内容复核发现 q2 援引历史 research 并指出“只搜索、未读取的 sources-only 正文”仍可能放行；源码复核确认严格门禁误把 search hit 当作实际证据，违反 ADR-004。已收紧为 sources-only 必须有真实 read 或宿主冻结正式来源，并补直接拒绝回归；原 q2 保留为失败样本。
- 2026-07-29T20:55:38+08:00：q2 复核结论明确化：如果模型没有真正读取资料就直接回答，sources-only 状态机现在会在释放任何 deferred token 前检查 `readChunks`；只有 search hit、没有实际 read 时直接返回 `refused/insufficient_evidence`，引用清洗仍作为第二道防线。通用模式继续允许只汇报搜索命中，不被这条严格门禁误伤。
- 2026-07-29T20:58:21+08:00：q2 最终复跑先遇到一次真实准入波动并在问题前安全停止；随即复测阶段 1/2/3 全通过（流式阶段 14.379s，低于 45s），单次重试后 q2 以当前 `TASK-023.md` 为来源完成 1 search/1 read/1 受控引用，正确说明 `readChunks` 门禁与 `refused/insufficient_evidence`。证据见 `real-q2-authority-recheck.json`；未绕过准入或把失败缓存为通过。
- 2026-07-29T20:58:21+08:00：冻结 q1～q5 真实旗舰中位数为 `preflight=1ms / firstVisible=31648ms / total=31648ms / heartbeatGap=254ms`；对 TASK-019 的 `1/36516/36516ms`，前置耗时持平、首个正文与总耗时均改善 4868ms（13.33%）。10/10 资料题经内容复核完成；原 q2 失败与权威来源复跑均保留。
- 2026-07-29T20:59:47+08:00：用与串行基线相同的 300ms loopback provider 重测三次，并行结果 `679/618/618ms`、中位数 `618ms`；较串行 `926ms` 改善 `308ms`（33.26%）。各阶段耗时约 306～329ms，总耗时贴合 `max(阶段1+阶段2, 阶段3)`；9 个请求使用 2 个共享 TCP 连接。
- 2026-07-29T21:02:33+08:00：协议 v2、q2 严格门禁与最终证据加入后，从头复跑 `pnpm verify`（276/276 Node/TS、102/102 Rust，1 个既有 live MemOS 测试按设计忽略、生产构建）、Playwright 44/44、Rust fmt、严格 Clippy 全目标/全 feature `-D warnings` 与 `git diff --check`，全部通过。
- 2026-07-29T21:13:20+08:00：从候选提交 `90e509d47` 执行 `pnpm desktop:signed`，ad-hoc 签名构建并安装到唯一位置 `/Applications/Papertable.app`；`codesign --verify --deep --strict` 通过，bundle `com.papertable.app`、版本 `0.1.0`、二进制内 commit `90e509d47`，provider 配置保持 `0600`。已卸载构建 DMG，`/Applications` 与 `/Volumes` 只剩一个安装包。
- 2026-07-29T21:13:20+08:00：安装版可见界面验收通过。普通“测试连接”在 `595ms` 返回且没有能力探测状态；手动重新探测在 `584ms` 内显示阶段 1/3 进行中，最终三段为 `4080/2239/3163ms` 且全部通过。探测中窗口状态采样 `92ms`。真实提问在 `492ms` 内显示“正在探索”，随后显示第 2 轮、1 次检索、命中 4 段；生成中窗口采样 `68ms`，最终正文正常落卡。四张截图及完整发布结论见 `outputs/task-023/screenshots/` 与 `verification.md`。所有执行复选项已完成，任务保持 `in_progress`，等待监督者独立复核、推送与合入后再标记 `done`。
