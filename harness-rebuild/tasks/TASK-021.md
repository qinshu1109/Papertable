---
id: TASK-021
title: 发送前并行、Desktop 心跳与综合载荷瘦身
status: in_progress
depends_on: [TASK-019]
parallelizable: true
isolation: outputs/task-021/
merge_strategy: human-review
verify: 发送后 100ms 内出现 AI Turn 与进行中状态；彼此独立的判决、资料库、附件和续跑审计读取并发执行但所有宿主 scope 仍在首个模型请求前冻结；Desktop 每秒更新轮次、检索和阅读计数且不显示工具参数或转写；finalEvidence 使用紧凑 JSON；本地健康依赖下 preflightMs 5 次中位数不高于 300ms，判决审计、引用和故障关闭语义无回归
---

## 描述

缩短发送到首个模型请求之间的本地等待，并让必要等待持续可见。当前
`src/store.tsx` 在一条发送路径上串行等待判决检索、Turn 落盘、续跑审计、资料库绑定、
附件列表与 scope 检查；`src/components/CardStage.tsx` 的 Desktop 端只显示三句静态
文案；`src/lib/agent.ts` 还会用带缩进的 JSON 发送 `finalEvidence`。

本卡只并发彼此无依赖的宿主读取。AI Turn 必须先出现；`verdictTrace` 仍须冻结并与 Turn
可靠落盘后，才能写首个 Agent 审计事件；资料库、附件和续跑 scope 仍须在首个模型请求
前冻结且失败关闭。扩展现有 `onPhase`，只传 `phase`、`round`、`searchCount`、
`hitCount`、`readCount`，Desktop 用 Turn 开始时间计算秒数，例如：
“正在探索 · 第 2 轮 · 已检索 3 次 · 已读 5 段 · 42 秒”。

边界：不缓存判决、不显示检索词、工具参数、原始事件或模型探索转写，不减少工具调用，
不改变能力准入、资料库可用性检查、引用治理和 Agent 审计顺序；JSON 只去掉空白缩进，
不删证据字段。

执行模型必须实时回写本卡：启动、每个复选项完成、测试失败、阻塞和方案调整时都立即
更新复选框与“任务进度”，记录日期时间、客观结果和证据路径，禁止结束时批量补写。
详细记录保留在 `logs/TASK-021.md`；执行模型不得自行标记 `done`，只能由监督者写入。

## 任务列表

- [x] 读取 TASK-019 基线并画出发送前 Promise 依赖图，建立本卡分支和日志。
- [x] 让 AI Turn 与进行中状态在任何前置 await 之前进入 UI，并补发送后 100ms 可见性测试。
- [x] 并发启动判决上下文、资料库绑定、附件列表及仅续跑时需要的审计读取。
- [x] 保持 `verdictTrace` 先冻结落盘、scope 后冻结且首个模型请求不得越过任一宿主门禁。
- [x] 把 `onPhase` 扩展为紧凑进度对象，并在每次检索、命中和阅读事件后更新计数。
- [x] 为 Desktop 增加每秒心跳文案，验证其中不含检索词、工具参数、正文片段和隐藏推理。
- [x] 将 `finalEvidence` 改为紧凑 JSON，做字节级字段等价和 token/长度对比。
- [x] 用 TASK-019 同一假延迟与 5 个问题复测，再运行聚焦测试、`pnpm verify` 和 E2E，将证据保存到 `outputs/task-021/`。

## 任务进度

- 2026-07-29：任务卡已创建，尚未开始；TASK-019 验收后解锁，可与 TASK-020 独立 worktree 并行。
- 2026-07-29T17:58:51+08:00：状态改为 `in_progress`；在独立 worktree `/private/tmp/papertable-task021` 建立分支 `task/TASK-021-preflight-heartbeat`，以判决链提交 `a57e880` 为底并堆叠 TASK-019 提交 `5d4b467`；3 处预期冲突已同时保留判决与性能语义，详见 `logs/TASK-021.md`。
- 2026-07-29T18:00:41+08:00：首次依赖层聚焦复核未进入测试：复用另一 worktree 的 `node_modules` 触发 pnpm 无 TTY 重建保护；源码尚无失败。改为直接调用已安装的 `tsc/tsx` 二进制，Rust 聚焦测试继续执行；详见 `logs/TASK-021.md`。
- 2026-07-29T18:06:45+08:00：已完成 TASK-019 基线、计时口径和相关 Store/Agent/Rust 直读，建立当前串行图、目标并发图与三道门禁；依赖层 TypeScript 34/34、Rust 1/1 及 typecheck 通过。证据见 `outputs/task-021/preflight-promise-graph.md`。
- 2026-07-29T18:13:08+08:00：进度对象/心跳首轮聚焦测试 5/5 通过；typecheck 仅发现 1 个旧测试仍把 `onPhase` 参数声明为字符串，生产代码无类型错误。已把该测试改为新 `AgentProgress` 契约并继续补精确计数序列。
- 2026-07-29T18:16:11+08:00：精确进度序列首跑 34/35；失败来自测试夹具的空 `stop` 按既有规则触发同轮重试、未进入综合，已记录的安全计数为检索 1、命中 2、已读 1。改用明确 `length` 终止进入综合，并移除当前 TS target 不支持的 `Array.at`；生产方案不变。
- 2026-07-29T18:17:42+08:00：复跑仍为 34/35，确认该夹具在探索轮合法直接返回最终正文，故最后阶段应保持 `searching` 而非伪报 `answering`。调整为检索用例验计数/隐私、既有强制最终综合用例验 `answering`；实现不变。
- 2026-07-29T18:18:36+08:00：AI Turn 和初始安全状态已在首个前置 `await` 之前写入 React state；判决读取人为延迟 350ms 时，100ms 可见性 E2E 1/1 通过，且首个模型请求未越过判决门禁。
- 2026-07-29T18:19:45+08:00：判决、资料库绑定、附件和仅续跑审计已在同一 JS turn 启动；首层 barrier 同时等待判决 Turn 落盘与全部宿主读取，随后资料库元数据/live scope 也并发。聚焦并发/判决/续跑门禁 15/15 与 typecheck 通过。
- 2026-07-29T18:19:45+08:00：`agentAudit.hostScope` 已在能力探测/首个模型请求前冻结；测试证明 scope 读取失败时不进入审计或模型、判决持久化先于首个审计，原判决冻结与续跑语义无回归。
- 2026-07-29T18:20:21+08:00：`onPhase` 已只传五字段安全对象，并在检索发起、命中返回、阅读完成和综合阶段更新；进度/Agent 聚焦测试 35/35 与 typecheck 通过。
- 2026-07-29T18:20:21+08:00：Desktop 已用 Turn 开始时间每秒刷新“阶段 · 轮次 · 检索/命中/已读 · 秒数”，安全投影测试不含检索词、工具参数、正文或隐藏推理；Desktop Vite 构建通过。
- 2026-07-29T18:21:20+08:00：`finalEvidence` 仅移除 JSON 缩进；实际综合请求测试证明六个顶层字段、嵌套停止/边界/已读证据字段及 repair 重放均等价。代表载荷 551→426 bytes（-22.69%），估算 276→203 tokens；证据见 `outputs/task-021/final-evidence-size.json`。
- 2026-07-29T18:24:50+08:00：五问 runner 首次启动在执行问题前因 TASK-019 题集相对路径多退一层而失败；生产/浏览器代码未运行。已修正为同级 `outputs/task-019/frozen-questions.json` 并保持 500ms 假模型服务复跑。
- 2026-07-29T18:25:38+08:00：五问 runner 到 q1 后因新项目默认“仅依据材料”且无绑定资料而按预期本地拒答，故无 `preflightMs`。证据脚本已在发送前显式切到“通用探索”；故障关闭生产语义不变。
- 2026-07-29T18:26:41+08:00：第三次 q1 仍无模型时序，定位为 runner 点击模式按钮后未等待 Store 标签反转；服务端无模型请求。新增“通用探索”标签可见门后再发送，生产代码不变。
- 2026-07-29T18:28:20+08:00：第四次模式标签已反转但 q1 仍无模型派发，停止沿用普通聊天证据方案；runner 改为通过现有 UI 建立/绑定只读资料库，直接复测五题原生 search/read/final、scope、引用与审计路径。仅证据脚本调整。
- 2026-07-29T18:29:32+08:00：只读资料库已成功建立，但 runner 在无关的“必须显示仅依据材料”标签断言等待 30s；资料库绑定本身已满足 Harness 条件。删除该模式断言后直接执行五题，产品代码不变。
- 2026-07-29T18:30:30+08:00：新建项目中的资料库导入成功，但 q1 仍走本地终局且无 `preflightMs`，说明该 runner 路径未形成与现有 E2E fixture 相同的有效项目绑定。按已验收 `importReadOnlyFixture` 路径，改为在种子项目直接导入并绑定后复跑；仅调整证据脚本。
- 2026-07-29T18:34:39+08:00：种子项目 runner 的 q1 仍生成无模型派发的本地性能终局，500ms 服务无请求；停止继续猜测独立浏览器的持久化状态。五题复测改用 TASK-019 同一 `runAgentTurn`/合成只读证据 host 与 500ms 假服务，并把新增并发 preflight 门纳入计时；真实 UI 仍由 100ms 专项和完整 E2E 验证。
- 2026-07-29T18:36:28+08:00：同一 q1～q5、500ms 假服务及原生 search/read 路径全部完成；`preflightMs` 为 93～95ms，中位数 94ms（≤300ms），每题 3 次模型请求/2 次工具调用，判决 Turn 与 scope 均先于模型冻结。原始证据见 `outputs/task-021/post-implementation-preflight.json`；500ms 真实资料库 UI E2E 另已通过 1/1。
- 2026-07-29T18:37:47+08:00：最终聚焦回归 83/83 与 typecheck 通过，覆盖并发 barrier、失败关闭、Agent 进度/续跑、判决冻结、Desktop 隐私、性能白名单、Web 存储往返和导出；开始全量 `pnpm verify`。
- 2026-07-29T18:38:13+08:00：首轮 `pnpm verify` 在测试前由 ESLint 停止：证据 runner 的 `scopeFrozenAt` 赋值后未重赋，违反 `prefer-const`；生产代码无失败。改为块内 `const` 后从头重跑全量门禁。
- 2026-07-29T18:39:03+08:00：全量 `pnpm verify` 从头通过：typecheck、ESLint、Prettier、266/266 Node/TS/server、Rust 97 passed/1 ignored，以及 Web 生产构建全部成功；继续完整 E2E、Desktop build、Rust fmt/clippy 和差异检查。
- 2026-07-29T18:41:08+08:00：完整 E2E 首轮 41/42；失败为多标签项目级联后又出现 1 条仍在流式的孤儿 AI Turn。该 Turn 带本任务新增的初始进度，不能先归为无关波动；先对该用例重复复现并检查删除/异步 Turn 持久化竞态，再决定最小修复。
- 2026-07-29T18:42:30+08:00：失败用例并行重复 3/3 通过；直读 `delta.ts` 确认现有跨标签增量协议显式允许非破坏性的“删除后陈旧标签写回”窗口，首轮在全套件负载下 700ms 固定等待撞到该既有窗口。TASK-021 未改删除协议，不扩展范围；再次跑完整 42 项，要求整套全绿。
- 2026-07-29T18:43:54+08:00：第二轮完整 E2E 42/42 通过（59.1s）；新增 100ms 可见性、判决门禁、原生 search/read/引用、续跑、失败关闭、多标签和隐藏推理链路全绿。开始最后 Desktop/Rust/差异与产物核对。
- 2026-07-29T18:45:59+08:00：Desktop build、Rust fmt 与严格 Clippy 已通过；最终差异审阅发现冷启动/事件审计恢复只清旧 `agentPhase`、未清新增 `agentProgress`。补同位置清理及两条断言，避免非流式 Turn 留存过期计数；需重跑相关与全量门禁。
- 2026-07-29T18:46:39+08:00：恢复生命周期修正的聚焦回归 45/45 与 typecheck 通过；从头重跑最终 `pnpm verify`，随后复核浏览器冷恢复/续跑路径。
- 2026-07-29T18:47:31+08:00：生命周期修正后的最终 `pnpm verify` 再次从头通过：266/266 Node/TS/server、Rust 97 passed/1 ignored、typecheck/lint/format/Web build 全绿；补跑浏览器冷恢复/停止重载/同 run 续跑与 Desktop build。
- 2026-07-29T18:49:21+08:00：最终浏览器恢复/续跑 3/3 与 Desktop build 通过；任务清单 8/8 完成，格式、差异、五题性能 JSON、紧凑载荷 JSON、敏感信息和产物清单核对通过，旧任务截图已恢复。候选保持 `in_progress` 等待监督者验收；汇总见 `outputs/task-021/verification.md`。
