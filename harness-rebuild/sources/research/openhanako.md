# openhanako (HanaAgent) Agent Harness 调研报告

> 调研对象：https://github.com/liliMozi/openhanako（产品名 **HanaAgent**），版本 `0.421.24`
> 调研目的：为 **Papertable**（Tauri + SQLite + React/TS，只读笔记库，工具集为 `search_notes` / `read_notes`）设计 agent harness 提供参考
> 调研方式：只读源码分析。本地为 shallow sparse worktree，已展开 `desktop/src/react/` 之外的全部源码目录（React 前端仅通过 `git ls-files` / `git show` 查看）
> 结论前置：**它的 agent loop 本身不在这个仓库里**——真正可借鉴的是它围绕一个第三方 loop 造的一整套"防御层"。这层东西对 Papertable 价值最大。

---

## 0. 一句话结论

HanaAgent 不是"harness 参考实现"，而是"**harness 加固层参考实现**"。它把 agent loop 外包给了 `@earendil-works/pi-agent-core`（闭源 npm 包），自己写的 17 万行 TypeScript 几乎全是外围：模型兼容补丁、流事件守卫、会话 JSONL 的读时修复、事件总线到 UI 的翻译层、PathGuard 权限模型。对 Papertable 来说，**loop 逻辑要自己写（照它抄不到），但这些加固层的问题清单和解法可以直接照搬**——它们代表了真实用户量下踩出来的坑。

---

## 1. WHAT IT IS：定位、语言、架构、许可、成熟度

### 1.1 定位

面向**普通办公用户**（非 coder）的桌面端个人 AI 助理。README 的原话是"弥合绝大多数人和 AI Agent 之间的缝隙，让强大的 Agent 能力不再只局限于命令行里"。相对于 Claude Code / Codex 这类 coding agent，它多做了：记忆系统、人格（"ishiki"）、多 Agent 协作、定时任务、外部 IM 平台接入（Telegram / 飞书 / QQ / 微信）、插件市场。

**与 Papertable 的定位差异极大**：HanaAgent 是"全能力开放 + 沙盒收紧"，Papertable 是"能力极小 + 边界天然只读"。所以本报告后半部分的重点是**哪些复杂度是它的场景带来的、Papertable 不需要**。

### 1.2 语言与技术栈

| 项 | 内容 |
|---|---|
| 语言 | TypeScript（`.ts` 为主，2167 个 ts/tsx 文件） |
| 规模 | `core/` + `lib/` + `server/` + `shared/` 约 **170,185 行** |
| 桌面壳 | **Electron 42.3.0**（`desktop/`），非 Tauri |
| 前端 | React + Zustand（`desktop/src/react/`，store 切片式：`agent-slice.ts` / `agent-activity-slice.ts` / `subagent-preview-slice.ts`） |
| 后端 | **Hono 4.x + @hono/node-server + @hono/node-ws**（`server/`），即 Electron 主进程里跑了一个真 HTTP/WS server |
| 存储 | **JSONL**（会话历史）+ **better-sqlite3 12.x**（记忆 / session manifest）+ JSON 文件（配置） |
| Agent 内核 | `@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent`，均锁定 `0.80.3` |

### 1.3 架构分层

```
desktop/               Electron main / preload / splash / native
desktop/src/react/     React 前端（通过 WS 或 IPC 消费事件）
server/                Hono HTTP + WebSocket（routes/ 43 文件，chat.ts 是核心）
  ├─ routes/chat.ts            SDK 事件 → 前端 WS 消息的翻译层（最重要的文件之一）
  ├─ session-stream-store.ts   每轮回复的事件 ring buffer（断线重放）
  └─ ws-protocol.ts            WS 消息形状定义
core/                  引擎与协调器（无 UI，无 SDK 直接依赖）
  ├─ engine.ts                 3219 行的 Thin Facade，只持有各 Manager
  ├─ session-coordinator.ts    8088 行，真正的会话生命周期 / 回合驱动
  ├─ provider-compat.ts + provider-compat/   逐 provider 的请求体补丁
  └─ llm-client.ts             非流式 utility 调用（标题生成、摘要等）
lib/
  ├─ pi-sdk/            ★ 唯一允许 import "@earendil-works/*" 的模块（适配器）
  ├─ tools/             ~40 个工具实现
  ├─ sandbox/           PathGuard + macOS Seatbelt / Linux bubblewrap / Windows restricted token
  ├─ memory/            记忆系统（SQLite + FTS5）
  └─ providers/         ~40 个 provider 定义（多数只有 15~30 行）
shared/                 前后端共享类型与纯函数（model-capabilities.ts 等）
packages/               插件 SDK / protocol / runtime / components
plugins/ examples/      内置与示例插件
```

**一个值得学的架构纪律**：`lib/pi-sdk/index.ts:1-13` 明确写了"所有 PI SDK 导入的唯一入口……消费方不应直接 import `@earendil-works/*`，全部从这里导入"，并附了纪律清单（不接受 engine/agent/config 参数、不拼 session options、不做工具过滤、不持有状态）。这是一个**单点收口的 SDK 适配器**，让第三方 SDK 的版本漂移只影响一个目录。`lib/pi-sdk/session-options.ts:14-41` 甚至在运行时读取 SDK 的 `package.json` 版本号并做行为分支（`isPiSdkNameAllowlistVersion`，0.68 起 `tools` 从对象数组变成字符串白名单）。

### 1.4 许可

**Apache-2.0**（`package.json:6`，`LICENSE` 为标准 Apache 2.0 全文）。可商用、可修改、需保留声明与 NOTICE。**但注意**：核心 agent loop 在 `@earendil-works/*` 三个 npm 包里，这些包不在本仓库、许可未在此声明——**照抄这个仓库拿不到 loop，需要自己实现或另找 loop 实现**。

### 1.5 成熟度

- 版本号 `0.421.24`——四段式，暗示高频发布；仓库有 `release-digest.v1.json` / `v2.json`（后者 160KB）作为发布摘要基础设施。
- **1013 个 `.test.ts(x)` 文件**，测试覆盖相当密集。
- 代码注释里大量引用 issue 号（`#521`、`#1285`、`#1624`），说明这些防御逻辑是从真实缺陷回归来的，不是设计时想出来的。
- 有 `SECURITY.md` / `CODE_OF_CONDUCT.md` / `CONTRIBUTING.md`；GitHub Actions workflow 5 个。
- 已签名公证的 macOS 构建；Windows 未签名。

**成熟度判断**：真实在用的产品级项目，工程规范高于一般 OSS。但**耦合极重**——`session-coordinator.ts` 单文件 8088 行，`server/routes/chat.ts` 1700+ 行的事件 switch，不适合整体移植，只适合摘取模式。

---

## 2. AGENT LOOP：驱动、迭代上限、终止态、错误处理、降级

### 2.1 关键发现：loop 在 SDK 里，本仓库只驱动它

本仓库**没有** "while (hasToolCalls) { callModel(); runTools(); }" 这样的循环。检索证据：

- `lib/pi-sdk/index.ts:46` 只是 re-export：`export { runAgentLoop } from "@earendil-works/pi-agent-core";`（注释写"低层 AgentLoop（隔离 side lane 用）"，即只在旁路任务用）
- 主链路的驱动是**单次 await**：`core/session-coordinator.ts:4881` → `await this._session.prompt(text, promptOpts);`，以及路径感知版本 `core/session-coordinator.ts:4997` → `await entry.session.prompt(text, promptOpts);`
- 模型调用 + 工具调用的交替、工具结果回灌、何时结束，全在 `pi-coding-agent` 的 `Session.prompt()` 内部。

Hana 通过**扩展钩子**介入 loop，而不是重写 loop：

| 钩子 | 位置 | 作用 |
|---|---|---|
| `agent.streamFn` | `lib/pi-sdk/stream-guard.ts:11-14` | 包住流，逐事件过守卫 |
| `agent.afterToolCall` | `lib/pi-sdk/tool-outcome-adapter.ts:15-36` | 把 Hana 工具返回值里的 `isError` 位提升为 SDK 的失败语义 |
| `agent.transformContext` | `lib/pi-sdk/tool-outcome-adapter.ts:39-44` | 重放时投影历史工具失败 |
| `before_provider_request`（Pi SDK extension） | `core/engine.ts` 附近装载 | 序列化前打 provider 兼容补丁 |
| `resourceLoader` 包装 | `core/session-coordinator.ts:2057` | per-session prompt 快照 + plan mode 注入 + vision 辅助 |

> **对 Papertable 的含义**：loop 必须自己写。好消息是只读双工具的 loop 非常简单（几十行）。真正要抄的是下面 2.3~2.5 的防御。

### 2.2 迭代上限 / 预算控制：**基本不存在**

这是本次调研最意外的负面发现。全仓库检索 `maxSteps` / `maxIterations` / `maxTurns` / `MAX_STEPS` / `stepLimit` / `maxToolCalls` —— **零命中**（`core` `lib` `server` `shared` 全域）。

也就是说：

- **没有"最多 N 轮工具调用"的硬上限**。防止无限 tool_calls 的唯一机制是时间维度的看门狗（见 2.4）。
- **没有 token 预算 / 成本上限熔断**。`lib/llm/usage-ledger.ts`（304 行）+ `lib/llm/usage-observer.ts`（200 行）只做**记账**：`normalizeLlmUsage()` 归一化各家的 usage 字段（`input_tokens` / `prompt_tokens` / `cache_read_input_tokens` / `prompt_tokens_details.cached_tokens` / `reasoning_tokens` 等），算成本，`hub.eventBus.emit({ type: "token_usage", ... })`（`server/routes/chat.ts:1665`）给插件消费。**记完就完了，不触发中断**。
- 上下文预算通过**压缩**而非拒绝来处理（见 4.4）。
- 输出长度有一个 provider 侧的协商层：`core/output-length-contract.ts` + `core/provider-compat/output-budget.ts` 的 `normalizeImplicitOutputBudget()`——它做的事是**删掉 SDK 注入的默认 `max_tokens`**（当它恰好等于 `min(model.maxTokens, 32000)` 且 provider 不强制要求时），避免默认值意外截断长回复。这是"放开限制"而非"施加限制"。
- 运行时内存压力有阈值（`core/session-coordinator.ts:660-670` 附近 `DEFAULT_RUNTIME_PRESSURE_THRESHOLDS`：`minRetainedBytes 16MiB` / `highPayloadBytes 64MiB` / `highRssBytes 1536MiB` / `highExternalBytes 512MiB`），触发的是**历史裁剪**（`_scheduleRuntimePressureCheck`），不是终止回合。

**Papertable 必须补上这一课**：一个 24 小时开着的笔记应用如果模型陷入 `search_notes` 死循环，Hana 的模型下要烧 20 分钟才停。建议 Papertable 显式加：`maxSteps`（建议 8~12，只读双工具场景足够）、`maxToolCallsPerTool`（防同一查询反复重试）、per-turn token 上限。

### 2.3 终止态全集

把 SDK 的 `stopReason` 和 Hana 自己合成的终止路径合起来，一个回合可能以以下状态结束：

**A. SDK 侧 `stopReason`**（消费点 `core/session-coordinator.ts:668-678` 的 `isolatedCompletionError()`，以及 `lib/tools/subagent-tool.ts:175-187` 的同构实现）：

| stopReason | 语义 | Hana 处理 |
|---|---|---|
| `stop` | 正常完成 | 返回 `null`（无错误） |
| `error` | provider / 内部错误 | 报 `errorMessage`，落 `hasError`，广播 `{type:"error"}` |
| `length` | 输出被 max_tokens 截断 | 报 `"assistant message ended with stopReason=length (output limit reached)"` |
| `aborted` | 被中止 | `lib/llm/session-snapshot-side-task-runner.ts:21` 与 `error` 同等看待（旁路任务视为失败） |
| 其它 | 未知 | 兜底 `assistant message ended with stopReason=${stopReason}` |

**B. Hana 合成的终止**（`server/routes/chat.ts:1619-1700` 的 `turn_end` handler）：

1. **正常结束**：`turnWasSuccessful = !aborted && !hasError && (hasOutput || hasToolCall || hasThinking)`（`chat.ts:1634`）。
2. **用户中止**：WS `abort` 消息 → `hub.abort()` → `SessionCoordinator.abort()`（`core/session-coordinator.ts:4922-4940`）→ `abortSession()` → `_forceReleaseStreamingSession()`。
3. **看门狗超时中止**：`reason: "turn_stall_timeout"`（`chat.ts:951`）。
4. **断线宽限中止 / 关机 `abort_all`**：`abortAllStreaming()`（`core/session-coordinator.ts:5621-5631`），依赖事件自带的 `event.aborted === true` 识别（因为 `ss.isAborted` 不会被置位，见 `chat.ts:1620-1622` 的注释）。
5. **★ 空回复终止（"模型什么都没说"）**：`chat.ts:1631-1634`
   ```
   if (!ss.hasOutput && !ss.hasToolCall && !ss.hasThinking && !ss.hasError && !turnWasAborted) {
     ss.hasError = true;
     broadcast({ type: "error", message: t("error.modelNoResponse"), sessionPath });
   }
   ```
   这是"模型不给 final text"的显式检测：一轮里既无可见文本、又无工具调用、又无 thinking，就当作配置错误报给用户。被 abort 的回合豁免。**这条对 Papertable 直接可抄**。
6. **模型不可用**：`_assertSessionModelAvailable()`（`core/session-coordinator.ts:4813-4860`）在每轮开始前重新校验 session 持有的 `{provider, id}` 是否还在当前允许列表里，不在就抛 `MODEL_NOT_AVAILABLE` / `MODEL_REBIND_FAILED`。理由写在注释里："Pi sessions retain their model object across turns; a provider refresh can therefore leave a disabled model usable unless every new turn revalidates"。
7. **会话忙**：`if (entry.session.isStreaming) throw new Error("session_busy")`（`core/session-coordinator.ts:4980`），且是在异步媒体准备**之后**二次检查的——注释解释了为什么：路由层的守卫和真正提交之间有异步窗口。

### 2.4 唯一的失控保护：Turn Stall Watchdog

`server/routes/chat.ts:324-341` + `931-965`：

```
export const DEFAULT_TURN_STALL_ABORT_MS = 20 * 60_000;   // 20 分钟
export function resolveTurnStallAbortMs(value = process.env.HANA_TURN_STALL_ABORT_MS) { ... }
```

机制：
- `markTurnStreamActivity()`（`chat.ts:962-966`）在每次流活动时刷新 `lastStreamActivityAt` 并重排定时器。
- 定时器到点后**二次确认** `idleFor >= turnStallAbortMs`（防止定时器提前触发），且确认 `isSessionRuntimeStreaming(sessionPath)` 仍为真，才置 `ss.isAborted = true` 并中止。
- `ss.turnStallTimer.unref?.()`——不阻塞进程退出。
- 设 `0` 可禁用。

这是**空闲超时**，不是总时长超时。一个每 10 秒吐一个 token 的模型可以无限跑；一个疯狂调工具的模型只要工具一直有输出也能无限跑。**Papertable 应该同时要空闲超时和总步数上限。**

### 2.5 ★★ 模型行为不端时的降级：`stream-guard.ts`（最值得抄的单个文件）

`lib/pi-sdk/stream-guard.ts`（246 行）解决一个具体的现实问题：**小模型 / 国产模型经常吐出"名字为空的 tool call"**——即它想说话，但被自己的 tool-calling 格式带跑了，产出一个 `{type:"toolCall", name:"", partialArgs:"..."}`。SDK 会把这个当无效工具调用，用户看到的是"模型什么都没回"。

Hana 的处理（`guardStreamEvent()`，`stream-guard.ts:48-85`）：

1. **拦截**：`toolcall_start` / `toolcall_delta` 事件若 `isEmptyNameToolCall(toolCall)`（`name` trim 后为空，`:96-98`），**不下发**，改为把 delta 累积进旁路缓冲（`bufferInvalidToolCallEvent`，`:166-184`，处理 delta 增量与 `partialArgs` 前缀两种累积形态）。
2. **恢复**：到 `toolcall_end` 时调 `recoverInvalidToolCallText()`（`:123-135`）尝试把参数抢救成人类可读文本：
   - 先尝试 `JSON.parse`，然后从 `text` / `content` / `message` / `body` / `input` 五个常见键里取字符串（`recoverTextFromValue`，`:205-212`）；
   - 若是裸文本（不以 `{` / `[` 开头），直接当正文；
   - **若被 `isToolProtocolFragment()` 判定为工具协议碎片，丢弃**（`:132-133`，注释："工具协议碎片：是失败的工具调用，不是 prose，丢弃（不回写成可见文本）"）。
3. **改写事件流**：抢救出文本后，**伪造一组 text 事件下发**（`:67-71`）：
   ```
   { type: "text_start", contentIndex, partial },
   { type: "text_delta", contentIndex, delta: text, partial },
   { type: "text_end",   contentIndex, content: text, partial }
   ```
   前端和后续持久化完全不知道这里曾经有个坏 tool call。
4. **消息级清洗**：`sanitizeAssistantMessage()`（`:100-111`）在 `done` / `error` / 任何带 `partial` 的事件上，把 content 数组里的空名 toolCall 块替换成 text 块，并与相邻 text 块合并（`appendTextBlock`，`:113-121`）。
5. **流异常兜底**：`guardAssistantMessageStream()`（`:22-40`）用 try/catch 包住 `for await`，异常时 push 一个**结构完整的合成 assistant message**（`createErrorMessage`，`:227-246`：`stopReason: "error"`，`usage` 全零但字段齐全，`errorMessage` 填实）。**保证下游永远收到形状合法的消息**，不会因为流炸了而出现 undefined。
6. **幂等安装**：`Symbol.for("hana.piSdk.streamGuardInstalled")` 标记（`:5,9,15`）防止重复包装 `streamFn`。

配套的 `lib/tool-protocol-sanitizer.ts` 识别模型泄漏到正文里的工具协议标签，标签集（`:1-9`）：`tool_calls` / `tool_call` / `function_calls` / `function_call` / `tool_use` / `invoke` / `parameter`。检测前先做 **NFKC 归一化 + 去零宽字符**（`:18-22`，`ZERO_WIDTH_RE = /[​-‍﻿]/g`），并且正则同时匹配**全角尖括号 `＜＞`**（`:14-15`）——因为中文模型真的会吐全角。还处理 `<|...|>` 形式的 channel marker（`CHANNEL_MARKER_RE`，`:13`）。

> **这是整个仓库对 Papertable 最有价值的部分**。只读笔记场景大概率会接入本地/小模型（Ollama、Qwen 小尺寸），空名 tool call、协议标签泄漏到正文、全角标签，都是必然会遇到的。这套"拦截 → 抢救 → 伪造 text 事件 → 消息级清洗 → 合成错误消息兜底"的五段式，可以近乎逐行翻译成 Rust 或 TS。

### 2.6 工具错误处理：错误进模型，不炸回合

- 统一结果形状：`lib/tools/tool-result.ts:1-32`
  ```
  type ToolResult<D> = { content: {type:"text",text:string}[]; details: D; isError?: true };
  toolOk(text, details)    → { content, details }
  toolError(text, details) → { isError: true, content, details: {...details, error: text} }
  ```
  **所有失败都是"返回一个带 isError 的正常结果"，不是抛异常。** 模型看到的是一段文本错误说明，可以自行重试或换路。
- `installToolOutcomeAdapter()`（`lib/pi-sdk/tool-outcome-adapter.ts:15-36`）把 Hana 的 `result.isError` 提升成 SDK 的 `context.isError`，因为"Pi treats a normally returned tool value as success"。
- 权限拒绝也走结果通道：`lib/sandbox/tool-wrapper.ts:27-31` 在执行前 PathGuard 检查失败时返回 `blockedResult()`，不抛。
- **工具执行去重（幂等）**：`lib/pi-sdk/session-options.ts:114-131` 的 `wrapToolDefinitionExecutionOnce()` 用 `toolCallId`（或退化为 `assistant:{msgId}:tool:{name}:args:{stableJson(params)}`，`:101-108`）做 key，缓存 in-flight Promise，**同一个 tool call 重复触发时复用同一次执行**。`stableJson()`（`:65-77`）是带循环引用保护的稳定序列化。这防的是 SDK 重试 / 事件重放导致的副作用重复执行。

---

## 3. PROVIDER LAYER：多供应商、能力探测、流式

### 3.1 多供应商架构

- **注册**：`core/provider-registry.ts:411-453`，40+ 个内置 provider plugin 以声明式数组 `BUILTIN_PLUGINS` 注册，与用户 catalog 合并。每个 provider 声明 `id` / `displayName` / `authType`（`api-key` | `oauth` | `none` | `optional`）/ `defaultBaseUrl` / `defaultApi`。
- **provider 定义极薄**：`lib/providers/` 下多数文件 15~30 行（`zhipu.ts` 15 行、`openrouter.ts` 16 行、`openai.ts` 95 行）。差异被推到两个地方：协议族 + 兼容补丁。
- **协议族**（4 种，`core/provider-registry.ts:249` / `lib/providers/openai.ts:61` / `lib/providers/anthropic.ts:11`）：
  - `openai-completions`（Chat Completions）
  - `openai-responses`（Responses API）
  - `openai-codex-responses`（ChatGPT Codex OAuth 端点）
  - `anthropic-messages`
- **覆盖面**：OpenAI / Anthropic / DeepSeek / Gemini / Groq / Mistral / DashScope(Qwen) / 智谱 / Kimi(Moonshot) / 火山引擎 / 百度 / Ollama / Perplexity / xAI / SiliconFlow / Fireworks / Together / MiniMax / MiMo，以及 `*-coding` 变体（`dashscope-coding.ts`、`kimi-coding.ts`、`zhipu-coding.ts`、`volcengine-coding.ts`）。
- **★ 单点归一化**：`core/provider-compat.ts:345` 的 `normalizeProviderPayload(payload, model, options)` 是**唯一**的请求体变换入口，流式和非流式共用。流程（`core/provider-compat.ts:64-78`）：先打通用补丁，再 first-match-wins 派发到 provider 专属模块（`core/provider-compat/` 目录，18 个文件）。通用补丁包括：
  - 空 `tools` 数组剥离（很多 provider 对 `tools: []` 报 400）
  - thinking 格式校验
  - **孤儿 tool-result 配对修复**（`core/provider-compat/tool-pairing.ts`，见 4.2）
- **HTTP 路径**：非流式 utility 走 `core/llm-client.ts:552` 的 `callText()`，直接 `fetch()` POST；URL 拼接由 `lib/llm/provider-client.ts:27` 的 `appendProviderApiPath()` 统一（`/chat/completions` vs `/v1/messages`）。流式走 SDK，Hana 通过 `before_provider_request` 钩子在序列化前打补丁。

### 3.2 能力探测

能力是**声明式元数据**，不是运行时探测。`shared/model-capabilities.ts`：

| 能力 | 字段 | 位置 |
|---|---|---|
| 工具调用 | `compat.toolUse = { supportsTools, dialect, toolResultFormat, supportsParallelToolCalls?, supportsForcedToolChoice?, supportsServerTools? }`，`dialect ∈ openai\|anthropic\|gemini\|mistral\|none`，`toolResultFormat ∈ message\|content_block\|part` | `shared/model-capabilities.ts:101-107,181-205` |
| 推理/thinking | `compat.thinkingFormat ∈ anthropic\|qwen\|qwen-chat-template\|zhipu\|deepseek\|openrouter\|kimi\|volcengine\|longcat`；`compat.reasoningProfile ∈ anthropic-adaptive-only\|deepseek-v4-*\|mimo-openai\|openrouter-anthropic-adaptive\|zhipu-openai\|kimi-openai` | `shared/model-capabilities.ts:79-99`，映射表在 `core/provider-compat/README.md:100-119` |
| 视觉 | `visionCapabilities` 元数据对象 | `shared/model-capabilities.ts` |
| 上下文/输出 | `context` / `maxOutput` / `image` / `video` / `reasoning` / `xhigh` | `core/provider-registry.ts:49-54,93-94` |

特例硬编码：`core/provider-compat/anthropic.ts:14-15` —— Claude Fable/Mythos 5 只支持不可关闭的 adaptive thinking。

**★ 关键负面发现：没有 prompt-based（文本编码）工具调用回退。** 遍查 `core/provider-compat/*` 与相关模块，`supportsTools: false` 的模型就是**不能用工具**，二元判定，没有 XML/JSON 提示词协议兜底。

> 这一点对 Papertable 需要决策：如果目标包含"任何本地模型都能用"，就必须自己实现 prompt-based 工具协议（Hana 帮不上）。反过来说，Hana 有 `tool-protocol-sanitizer.ts` 恰恰说明**模型会自发地吐 prompt-style 工具调用**——那么把它从"要清洗掉的垃圾"变成"要解析的备用协议"，是 Papertable 可以做得比 Hana 更好的地方。

请求策略层 `core/llm-request-policy.ts:14-33` 的 `buildProviderCompatOptions()` 传递 `mode`（`utility` | `chat`）、`callPurpose`（`auxiliary_vision` | `utility` | `health_check` | `summary` | `chat`）、reasoning level、输出预算来源。**utility 模式强制 `reasoningLevel: "off"`**（`:29`）——辅助调用（生成标题、摘要）不浪费 thinking token。这个"主链路 vs 旁路调用用不同策略"的分离很干净。

### 3.3 流式处理

**分工**：SSE 解析、text/reasoning/tool-args delta 累积、tool call 重组，全在 Pi SDK 内部，本仓库不可见。Hana 在 SDK 之上做两件事：

1. **流守卫**（`lib/pi-sdk/stream-guard.ts`，已详述于 2.5）。
2. **事件语义翻译**（`server/routes/chat.ts:1262-1300`）。SDK 的 `message_update` 携带 `assistantMessageEvent`，子类型 `text_delta` / `text_end` / `thinking_delta` / `toolcall_start` / `error`。Hana 的处理有几个细节值得注意：
   - `thinkingDeltaFromEvent()`（`chat.ts:1225-1231`）从 **7 个候选键**里找 thinking 文本：`delta` / `reasoning_content` / `reasoning_text` / `thinking` / `thinking_text` / `reasoning` / `text`——因为各家字段名不统一。
   - **phase 缓冲**：`shouldBufferPhaseText(subEvent)` 的文本不实时下发，攒到 `text_end` 再判断 `getAssistantTextPhase(block)`，若是 `"commentary"` 就**整段丢弃**（`chat.ts:1279-1287`）。
   - **thinking 状态机**：任何可见文本 delta 到来时若 `ss.isThinking` 则先补发 `thinking_end`（`chat.ts:1242-1245`）；`toolcall_start` 时**故意不关** thinking（`chat.ts:1298-1299`，注释"不在这里关闭 thinking 状态"）；但 `tool_execution_start` 时关（`chat.ts:1307-1310`）。
   - **三级解析器串联**：`ThinkTagParser`（最外层）→ `MoodParser` → `CardParser`（`chat.ts:1246-1260`，实现在 `core/events.ts:30-439`）。分别负责剥 `<think>` 标签、提取"心情"块、提取 `<card plugin=... route=...>` 插件卡片。每个都是**增量喂入 + 回调发事件**的流式解析器，`turn_end` 时统一 `reset()`（`chat.ts:1690-1692`）并 `flushTerminalParsers()`（`chat.ts:1623`）。

**非流式路径**（`core/llm-client.ts:575-650`）：`fetch()` + `await res.text()` + `JSON.parse`，按协议三分支——Anthropic 从 `data.content[]` 里挑 `type:"text"` / `type:"thinking"`（`extractAnthropicText`，`:629`）；`openai-responses` 若 `res.body.getReader` 存在则走 `readCodexResponsesStream()`；其余从 `data.choices[0].message.{content, reasoning_content}` 取（`extractOpenAICompatibleCompletion`，`:648`）。

### 3.4 健壮性

| 项 | 实现 | 位置 |
|---|---|---|
| 慢响应告警 | 15 秒阈值 → `LLM_SLOW_RESPONSE` 上 errorBus（**只告警不中断**） | `core/llm-client.ts:568-573` |
| 认证失败 | 401/403 → `LLM_AUTH_FAILED` | `core/llm-client.ts:620-621` |
| 限流 | 429 → `LLM_RATE_LIMITED`，**无自动退避重试** | `core/llm-client.ts:622-623` |
| 超时 | `combinedSignal`（用户 signal + 超时）→ `LLM_TIMEOUT`；`signal?.aborted` 抛 `AbortError` | `core/llm-client.ts:662-666` |
| 空响应 | thinking 抽完后正文为空 → `LLM_EMPTY_RESPONSE`，`context.reason = "empty_after_thinking"` | `core/llm-client.ts:668-677` |
| 重试 | **无退避重试逻辑**，交给 SDK 或调用方 | — |
| 用量归一 | `normalizeLlmUsage()` 覆盖 input/output/cacheRead/cacheWrite/reasoning 的各家别名 | `lib/llm/usage-observer.ts:90-124` |
| Prompt 缓存 | 三种策略 `SESSION_SNAPSHOT` / `UTILITY_TEMPLATE` / `CACHE_RECOVERY`；Anthropic 在 system + 最后 user 消息上打 `cache_control: ephemeral` | `lib/llm/cache-strategy-contract.ts`；`core/provider-compat/anthropic.ts:36-76` |
| 缓存亲和 | `lib/llm/provider-cache-affinity.ts`（76 行）——尽量让同一 session 命中同一缓存前缀 | — |
| 缓存保留式压缩 | `lib/llm/cache-preserving-compaction-agent-run.ts`（529 行）——压缩时保留前缀以不废掉缓存 | — |

**没有跨 provider 的缓存抽象**，各用各家原生机制。

---

## 4. STATE / TRACE / UI

### 4.1 持久化格式

**JSONL 追加日志 + SQLite 侧车索引**。

- 会话文件：`~/.hana/sessions/{sessionId}/*.jsonl`，一行一条 entry。
- Entry 类型（`core/session-jsonl-file.ts` / `lib/session-jsonl.ts`）：
  - `session` — 头（sessionId / 时间戳 / cwd）
  - `message` — LLM 消息，`role ∈ user | assistant | toolResult | compactionSummary`
  - `turn_input_presentation` / `turn_input_consumption` — 用户输入的**展示形态**与**实际被哪一轮消费**（`lib/turn-input-presentation.ts`；`server/routes/chat.ts:5022` 构造）
  - `content_block` — 工具产出的文件 / 媒体生成 / artifact
  - `session_info` — 会话名等元数据更新
  - `hana-session-branch-reset` — 分支检查点（`core/session-turn-actions.ts:29`）
- **工具调用与结果的存法**：tool call 是 assistant `message.content` 数组里的 `{type:"toolCall", id, name, input}` 块；tool result 是**独立一条** `role:"toolResult"` 的 message，用 `toolCallId` 回指。重放靠 `SessionManager.getBranch()` 线性读 + `parentId` 重建树。
- **SQLite 侧车**：`core/session-manifest/`（9 文件，store / resolver / ref / startup-migration / legacy-migration / db-files）—— 会话清单、分支头、权限模式快照走 SQLite；`core/session-list-projection-cache.ts` 做列表投影缓存。**即：真相在 JSONL，索引在 SQLite。**
- **并发安全**：`core/session-operation-lock.ts:22` 的 `acquireSessionOperation()` 互斥令牌，防同一会话上并发 retry / fork。
- **提前落盘**：`flushSessionManagerSnapshot()`（`core/session-coordinator.ts:2167`）——SDK 默认把首个 assistant 回复前的 entry 留在内存里，Hana 主动刷盘，好让侧栏 / 归档 / 视觉预处理立刻能看到这个会话文件；`schedulePreAssistantSessionManagerFlush()`（`:2209`）在非 assistant 的 `message_end` 上再刷。

### 4.2 恢复 / 中断 / 修复

**★ 这部分是"append-only 日志 + 第三方 loop"组合的必然代价，Papertable 若采用同构设计会遇到同样问题。**

打开会话前有一串**读时修复**（`core/session-coordinator.ts:4711-4780`）：

1. `_repairOrphanToolHistory()` → `repairOrphanToolResultEntriesInFile()`（`core/session-health.ts:208`）
   **根因**（注释 `core/session-health.ts:76`、`core/provider-compat/tool-pairing.ts:8-10`）：agentic 工具循环中，assistant 回包 `stopReason=error/aborted` 时 Pi SDK 仍会把已产生的 toolResult 落盘；重放时 SDK 的 transform-messages **整条丢弃** `error/aborted` 的 assistant，于是留下"没有前驱 `tool_calls` 的孤儿 `role:"tool"` 消息"→ 发给 OpenAI 兼容 provider **直接 400**。
   修复必须在 `SessionManager.open()` **之前**在文件层做（注释明写）。运行时 provider-compat 的 `tool-pairing.ts` 还有第二层兜底。
2. `_repairOversizedSessionHistory()` / `_projectOversizedSessionHistory()`（`:4732,4745`）—— 超大 JSONL 行投影裁剪，运行中也做（改 `manager.fileEntries` → `_buildIndex()` → 保留 leaf → `_rewriteFile()`）。
3. `_repairInlineMediaHistory()`（`:4767`）—— 清理历史里的 inline media（image/video/audio base64）。
4. **会话健康度**：`evaluateSessionHealth()`（`core/session-health.ts:33-72`）扫尾部 10 条 assistant，若 ≥3 条 `stopReason === "error"` 判为不健康，发 `{type:"session_unhealthy_warning", recentErrors, totalChecked}`（`core/session-coordinator.ts:4700-4705`）。健康检查**吃掉所有异常，绝不阻塞 restore**（注释明写）。

**中止的传播**（`_forceReleaseStreamingSession()`，`core/session-coordinator.ts:5650-5690`）。这段注释是整个仓库最有教育意义的一段：

> "停止按钮属于控制平面，不能等待 provider stream 自己收尾。这里先把 Hanako 侧的 sessionPath 控制权释放出来，再把 SDK abort 和资源清理丢到后台继续做。旧 session 的事件订阅和 SDK agent 连接会先断开，避免它之后恢复时把过期 delta 写回同一个前端会话或历史文件。"

顺序严格：
1. **先补发** `emitEvent({type:"turn_end", aborted:true, reason}, sessionPath)`（`:5660`）——因为紧接着的 `unsub()` 会抢在 SDK 自己的 `turn_end` 之前断流，前端就永远等不到 entry id 回绑（"重试/fork/重写按钮的唯一数据源"）。
2. 必须在从 `_sessions` 删除**之前**发——chat 路由的 `turn_end` handler 要通过 `getSessionByPath` 读内存分支才能算出 entry id（事件总线是同步分发）。
3. 然后清定时器、删 runtime 值、删 `_sessions`、置空 `_session`、`unsub()`、发 `session_status`。

**断线重放**：`server/session-stream-store.ts` 每轮一个 `streamId`，事件按 `seq` 递增，ring buffer 上限 `DEFAULT_MAX_EVENTS = 5000` / `DEFAULT_MAX_BYTES = 8MiB` / `DEFAULT_MAX_EVENT_BYTES = 256KiB`（`:13-15`）。注释解释了 5000 的来历："一个正常 turn（含 thinking + mood + 1.7k 字正文 + 少量 tool events）约产生 1~2k 条事件"。单事件超限时做**字段级压缩**：`LARGE_FIELD_KEYS = {base64, content, data, details, snapshot, text, thumbnail}`（`:18-27`）会被裁到 `MAX_COMPACT_STRING_CHARS = 8192`。`turn_end` 时 `finishSessionStream()` 清空 events，不长期占内存。客户端用 `{type:"resume_stream", streamId, sinceSeq}` 请求补发，响应带 `nextSeq` / `reset` / `truncated` 标志。**纯内存，进程重启即失效**——重启后靠 JSONL 重放而非 resume。

### 4.3 进度 → UI

**传输**：Electron IPC（桌面）/ WebSocket（Web + 移动 PWA + LAN 第二桌面端）。Hono + `@hono/node-ws`。协议形状定义在 `server/ws-protocol.ts`。

**事件词表**（`server/routes/chat.ts` 实际 emit 点，行号为证）：

| 类别 | 事件 | 行 |
|---|---|---|
| 文本 | `text_delta` | 1125, 1179 |
| 思考 | `thinking_start` / `thinking_delta` / `thinking_end` | 1247/1250/1253、1292/1295/1310、922、1159-1165 |
| 工具 | `tool_start`{id,name,args} / `tool_end`{id,name,status,success,error?,details} | 1315 / 1327 |
| 产出 | `content_block`{block}（file / media_generation / artifact / 插件卡片） | 636, 640, 817, 1349, 1396, 1403, 1414 |
| 回合 | `turn_end`{...persistedEntries} | 1670 |
| 错误 | `error`{message} | 376, 389, 401, 419, 1302, 1616 |
| 压缩 | `compaction_start` / `compaction_end` | 196 / 206 |
| 状态 | `status`{isStreaming, streamId, sessionPath} | 1452 |
| 富 UI | `card_start` / `card_text` / `card_end`、`mood_start` / `mood_text` / `mood_end` | 1130-1136、1147-1151 |
| 其它 | `todo_update`、`activity_update`、`agent_activity`、`browser_status`、`browser_bg_status`、`jian_update`、`devlog`、`notification`、`settings_confirm`、`confirmation_resolved`、`apply_frontend_setting`、`block_update`、`plugin_ui_changed`、`bridge_message`、`agent_review_status`、`token_usage` | 各处 |
| 会话 | `session_status`、`session_metadata_updated`、`session_unhealthy_warning`、`turn_input_consumption` | coordinator 侧 |

**参数瘦身**：`tool_start` 的 args 经 `summarizeToolStartArgs(toolName, args)`（`chat.ts:1313`），注释："只保留前端 extractToolDetail 需要的字段，避免广播完整文件内容"。`tool_end` 的结果经 `projectLiveToolResultOutcome()` 提取 `{status, success, error}`。**这是必要的**——`read` 工具的原始结果可能是几 MB 文本，广播会把 WS 打死。

**事件源头**：`session.subscribe(cb)`（`core/session-coordinator.ts:2207`），单个订阅里顺序做三件事：`recordAssistantUsage()` → `logDeepSeekReasoningVisibility()` → `this._d.emitEvent(event, sessionPath)`，并给事件补 `agentId`（供订阅方按 agent 过滤）。事件总线在 `hub/event-bus.ts`。

### 4.4 上下文窗口管理

- 触发：上下文占用超阈值自动压缩；用户 WS `{type:"compact"}` 手动触发；**切换模型到更小上下文时硬截断降级**。判定用 SDK 的 `shouldCompact`（`lib/pi-sdk/index.ts:115` re-export）。
- 压缩流程（`core/session-compactor.ts`）：`prepareCompaction()` 选出待摘要区间 → 调 LLM 生成摘要（缓存保留式，`lib/llm/cache-preserving-compaction-agent-run.ts`）→ 替换为 `role:"compactionSummary"` 消息 → 追加 `compaction_end` entry → 广播 `compaction_result`。
- **硬截断降级**：`core/compaction-utils.ts:27-54` 的 `computeHardTruncation(pathEntries, keepRecentTokens)`——纯函数，不调 LLM 不做 IO（文件头注释里写明了纪律）。用 SDK 的 `findCutPoint()` 找切点，处理 `isSplitTurn`（切点落在一轮中间就退到 `turnStartIndex`，保证不切开一个 turn），占位文案 `"[由于上下文超限，早期对话历史已被截断]"`。两个消费点：模型切换降级、摘要输入本身已超窗的兜底出口。
- 用户可见：`compaction_start` / `compaction_end`（带 `reason` / `aborted` / `tokens` / `contextWindow` / `percent`）。

---

## 5. FILE / CONTEXT LIFECYCLE：临时上下文 vs 索引材料

### 5.1 三条完全独立的通道

| 通道 | 落地位置 | 内容进 prompt 的方式 | 生命周期 |
|---|---|---|---|
| **聊天附件** | `~/.hana/session-files/`，文件名加时间戳+随机后缀（`lib/bridge/bridge-inbound-files.ts:23-78,114`） | **不内联**。注册进 per-session file registry（`registerSessionFile()`，`origin:"bridge_inbound"`，`:58`），模型按 fileId / 路径**用工具自己读** | per-session 缓存（key 为 sessionPath），无显式 TTL |
| **书桌 / 工作台** | 挂载点清单 `~/.hana/studio-mounts.json`（`core/studio-mounts.ts:14-92`），支持 `local_fs` / WebDAV / S3，每个挂载声明 capability（list/read/write/materialize/execute） | 通过 `MountAwareFileService`（`core/mount-aware-file-service.ts:20-102`）列目录/搜索，**只返回元数据**（`listFiles()` `:68-82`；`searchFiles()` 是文件名关键词搜索，limit 80，`:84-94`） | 持久 |
| **记忆** | SQLite `facts.db`（`lib/memory/fact-store.ts`） | 结构化"元事实 + 标签 + 时间"，检索后注入 | 持久归档 |

**核心观察：HanaAgent 不做"把用户文件切块 embedding 进向量库"这件事。** 它的模型是"给 agent 一个可读的文件系统视图 + 工具"，让模型自己找。`lib/memory/fact-store.ts:7-9` 的注释明确记录了一次架构回退：

> "替代 v1 的 store.js（SQLite + sqlite-vec 向量搜索）。**不使用 embedding / 向量 / score / decay / hit_count。**"

**没有向量库、没有 embedding 模型依赖。** 对本地优先应用是巨大简化。

### 5.2 没有"回合级临时上下文"的一等概念

检索未发现"本轮注入、轮末丢弃"的显式机制。session-files 是**会话级**缓存（`lib/session-files/session-file-registry.ts:39` 用 sessionPath 做 key），非回合级。相关的临时性设施是：

- `core/session-prompt-snapshot.ts` —— per-session 的 prompt 快照（包在 resourceLoader 上，`core/session-coordinator.ts:2057`），保证同一会话内 system prompt 稳定（缓存前缀友好）。
- `core/current-turn-native-media.ts` —— `beginCurrentTurnNativeMedia()` / `endCurrentTurnNativeMedia()`（`core/session-coordinator.ts:4872,4885` 的 try/finally 对），这是**唯一**明确的回合级作用域，用于本回合的原生媒体输入。
- `core/session-inline-media-prune.ts` 的 `pruneSessionInlineMediaHistory()` —— 每轮 finally 里调用（`:4886`），把历史里的 inline media 剪掉，防止 base64 累积炸上下文。配合 `core/message-sanitizer.ts` 的 `stripHistoricalInlineMediaForReplay()`。

### 5.3 大文件与图像

- 单条 JSONL 行超限有专门修复（`repairOversizedSessionEntriesInFile`）。
- 广播层有硬性截断（见 4.3 的 `LARGE_FIELD_KEYS` / 8192 字符）。
- 图像：`lib/pi-sdk/index.ts` re-export 了 `resizeImage` / `formatDimensionNote`；`core/model-image-preprocess.ts` 的 `prepareModelImageInputsForPrompt()` 在 prompt 前预处理（`core/session-coordinator.ts:4869`）。
- **文本模型收到图像时的降级**：`prepareVisionInputForTextOnlyModel()`（`core/session-coordinator.ts:4857-4867`）—— 目标模型不支持视觉时，通过 `VisionBridge` 调另一个视觉模型生成描述文本，把图换成文字。这是很实用的能力降级模式。
- 工具结果层面没有全局大小上限，各工具自己截（如 `lib/memory/memory-search.ts:96` tag 搜索 ≤15 条、FTS ≤10 条）。

### 5.4 检索实现（Papertable 最直接可复用的部分）

**A. 记忆检索**（`lib/memory/memory-search.ts:69-156`）—— 两级：
1. **标签匹配**：`factStore.searchByTags(tags, dateRange, limit=15)`。标签由 LLM 在**写入时和查询时**分别生成，然后直接字符串匹配。
2. **FTS5 兜底**：若标签结果 <3 条，追加 `factStore.searchFullText(query, limit=10)`。
去重后最多 25 条。

**B. FactStore 的 CJK 处理**（`lib/memory/fact-store.ts`）—— 这是最值得抄的技术细节：

```
CREATE VIRTUAL TABLE facts_fts USING fts5( ... tokenize='unicode61' )   // :141-146, :221-226
db.pragma("journal_mode = WAL"); db.pragma("synchronous = NORMAL");      // :108-110
```

`unicode61` 分词器**不会切分中文**，所以 Hana 用 **n-gram 预展开**绕过：

```
buildFactSearchText(fact, tags)          // :76-80
  = uniqueTokens([base, ...cjkNgrams(base)]).join(" ")   // 写入时把 CJK n-gram 展平进 search_text 列

buildFtsQuery(query)                      // :82-91
  = uniqueTokens([...lexicalTokens, ...cjkNgrams(normalized)])
      .map(w => `"${w.replace(/"/g,'""')}"`).join(" OR ")   // 查询时同样展开，OR 连接，双引号转义
```

三级降级：FTS 查询语法错误 → catch → `_likeFallback()`（`:393-396`）；FTS 零结果且 query 含 CJK → 也走 `_likeFallback()`（`:389-391`）；`_likeFallback` 是 `WHERE fact LIKE '%'||?||'%' ORDER BY time DESC LIMIT ?`（`:402-407`）。

**C. 会话搜索**（`lib/search/session-search.ts:9-46`）—— 纯词法打分：NFKC 归一 → 分词（CJK n-gram + ASCII 词）→ 打分（**标题整串命中 1000 分，正文整串 700 分**，token 命中按长度加权）→ limit 30（max 50）→ `buildSnippet()` 取约 108 字符窗口（`:125-138`）。有效 token 门槛：CJK ≥2 字符，ASCII ≥3 字符。

**D. 沙盒化的 grep / find**：`lib/pi-sdk/search-tools.ts`（744 行）的 `createGrepTool()` / `createFindTool()` —— 替换 SDK 内置版本，走 PathGuard。

### 5.5 只读边界：PathGuard

`lib/sandbox/path-guard.ts`：

```
AccessLevel = { BLOCKED, READ_ONLY, READ_WRITE, FULL }        // :24-29
OP_REQUIREMENTS = {                                            // :32-37
  read:   {READ_ONLY, READ_WRITE, FULL},
  write:  {READ_WRITE, FULL},
  delete: {FULL},
  stage:  {FULL},
}
```

**单一收口**：`check(absolutePath, operation)`（`:195`）→ `realpath` 解析（防符号链接逃逸）→ `_getAccessLevelResolved(canonicalPath)`（`:208`）。层级判定顺序（`:114-187`，策略数据在 `lib/sandbox/policy.ts`）：

1. `BLOCKED_FILES` / `BLOCKED_DIRS`（`policy.ts:14-17`，如 `hanakoHome/auth.json`、`browser-data/`）→ BLOCKED
2. `READ_ONLY_AGENT_FILES`（`policy.ts:20-25`，如 `ishiki.md`、`config.yaml`）→ READ_ONLY
3. `READ_ONLY_HOME_DIRS`（`policy.ts:28`，如 `user/`、`skills/`、`session-files/`）→ READ_ONLY
4. `READ_WRITE_AGENT_DIRS`（`policy.ts:31-39`，如 `memory/`、`sessions/`、`desk/`）→ READ_WRITE
5. workspace roots → FULL
6. `policyWritablePaths`（运行时缓存）→ READ_WRITE
7. 外部路径：`allowExternalReads === true` → READ_ONLY（`:167`），否则 BLOCKED
8. 兜底同上（`:185-186`）

**OS 级第二层**：`deriveSandboxPolicy()`（`policy.ts:103-141`）把上述级别投影成 `writablePaths` / `readablePaths` / `denyReadPaths`，交给 macOS Seatbelt / Linux bubblewrap / Windows restricted token。工具执行前的预检在 `lib/sandbox/tool-wrapper.ts:90-96`。

**会话权限模式**（`core/session-permission-mode.ts:1-12`）是**正交的第二个维度**：
```
SESSION_PERMISSION_MODES = { AUTO, OPERATE, ASK, READ_ONLY }
SESSION_APPROVAL_POLICIES = { INTERACTIVE, DENY_ON_PROMPT, NEVER }
```
工具按语义分三组：`INFORMATION_TOOLS`（`:22-32`：read/grep/find/ls/web_search/web_fetch/current_status/search_memory/recall_experience）、`SIDE_EFFECT_TOOLS`（`:34-55`）、`AUTO_REVIEW_TOOLS`（`:57-70`）。`READ_ONLY` 模式就是只放 INFORMATION_TOOLS。

**★ 一个重要的设计取舍**（`core/session-permission-mode.ts:72-73` 注释）：
> "subagent 上下文固定边界（与 permission mode 无关）：哪怕 operate 也拦。**收口在拦截层而非剥离**——subagent 工具对模型仍可见，调用时被拦（Codex 式甲），保证缓存前缀统一。"

即：**不从工具列表里删工具，而是让调用时被拒绝**——因为工具定义是 prompt 前缀的一部分，动态增删会破坏 prompt cache。这个洞见对 Papertable 有直接价值（若未来做多档权限，别动工具列表，动拦截层）。

### 5.6 工具层形状

- Schema 用 Pi SDK 的 `Type.*` 组合器（TypeBox 风格 → JSON Schema）：`Type.Object` / `Type.String` / `Type.Union` / `Type.Optional` / `Type.Array`（见 `lib/tools/file-tool.ts:88-125`）。**不是 Zod。**
- 工具对象字段（`lib/pi-sdk/session-options.ts:136-149`）：`name` / `label` / `description` / `parameters` / `prepareArguments` / `executionMode` / `renderCall` / `renderResult` / `renderShell` / `promptSnippet` / `promptGuidelines` / `execute`。注意有 **`renderCall` / `renderResult` / `renderShell` 三个 UI 渲染钩子挂在工具定义上**——工具自带前端展示逻辑，这个设计很干净。
- 校验：`assertAgentTool()`（`:43-53`）要求 `name` 非空字符串 + `execute` 是函数，否则 `TypeError`。
- 可用工具计算：`computeAvailableToolNames()`（`core/tool-availability.ts:36-56`）读 `agentConfig.tools.disabled` + 每个工具可选的 `isEnabledForAgentConfig(agentConfig, context)`（`:24-26`）。
- `computeReminderLiveToolAvailability()`（`core/tool-availability.ts:106-158`）做只读同步探针，**探针失败 fail-open**（`:147-149`）。
- **工具集快照与会话绑定**：`core/session-coordinator.ts:2255-2290` 三分支——restore + meta 有 `toolNames` → 重放快照；restore + meta 缺失 → 遗留会话保留全部工具；新建 → 从 agent config 计算。注释警告 `allToolNames` 必须覆盖 SDK 内置 + Hana 自定义 + 插件工具的完整集合，否则 `setActiveToolsByName` 会静默丢掉一批。还有 `core/session-capability-drift.ts` 处理"会话恢复时工具集已变化"的漂移。

---

## 6. REUSE VERDICT：对 Papertable 的取舍建议

### 6.1 强烈建议移植（高价值 / 低成本 / 与只读边界无冲突）

| # | 组件 | 源位置 | 为什么值得 | 移植成本 |
|---|---|---|---|---|
| **1** | **★ Stream Guard 五段式** | `lib/pi-sdk/stream-guard.ts` 全文（246 行） | 空名 tool call 抢救成可见文本、协议碎片丢弃、流异常合成结构完整的错误消息。**接本地/小模型必踩** | 低。纯函数式流变换，Rust/TS 都能逐段翻译 |
| **2** | **★ 工具协议清洗器** | `lib/tool-protocol-sanitizer.ts` | 标签集 + **NFKC 归一化 + 去零宽 + 全角尖括号**。中文模型真的吐全角标签 | 低。正则 + 归一化 |
| **3** | **★ 空回复检测** | `server/routes/chat.ts:1631-1634` | `!hasOutput && !hasToolCall && !hasThinking && !hasError && !aborted` → 明确报错。否则用户面对静默 UI | 极低。四个布尔 |
| **4** | **★ 统一工具结果形状 + 错误进模型** | `lib/tools/tool-result.ts:1-32` | `{content, details, isError?}`；失败是返回值不是异常，模型能自愈 | 极低 |
| **5** | **★ 中止顺序纪律** | `core/session-coordinator.ts:5650-5690` | 先补发 `turn_end` → 再断订阅 → 再清 registry。顺序错了前端就永远转圈 | 低，但**必须照抄顺序** |
| **6** | **★ 空闲看门狗** | `server/routes/chat.ts:324-341,937-965` | 20 分钟空闲阈值 + 到点二次确认 + `unref()` + 可配置为 0 禁用 | 低 |
| **7** | **★ CJK FTS5 n-gram 方案** | `lib/memory/fact-store.ts:76-91,141-146,381-407` | `unicode61` 不切中文 → 写入与查询双向 n-gram 展开 + OR 连接 + LIKE 三级降级。**Papertable 的 `search_notes` 直接就是这个** | 低。SQL + 分词函数，Rust rusqlite 同样适用 |
| **8** | **★ 工具执行幂等** | `lib/pi-sdk/session-options.ts:101-131` | `toolCallId` 为 key 缓存 in-flight Promise；`stableJson` 退化 key | 低 |
| **9** | **★ 广播层字段瘦身** | `server/session-stream-store.ts:18-27`；`chat.ts:1313` | `LARGE_FIELD_KEYS` 裁到 8192 字符；`summarizeToolStartArgs`。**`read_notes` 返回整篇笔记，不裁会打死 IPC** | 低 |
| **10** | **★ 拦截而非剥离** | `core/session-permission-mode.ts:72-73` | 不动工具列表（保 prompt cache 前缀稳定），改在调用点拒绝 | 零成本，只是一条设计原则 |
| **11** | **★ 单点 provider 归一化** | `core/provider-compat.ts:64-78,345` | 一个 `normalizeProviderPayload()` 入口 + first-match-wins 派发 + 通用补丁（空 tools 剥离等） | 中。结构可抄，补丁内容按接的 provider 挑 |
| **12** | 声明式能力元数据 | `shared/model-capabilities.ts:79-107` | `compat.toolUse.{supportsTools,dialect,toolResultFormat}` + `thinkingFormat` 的形状设计 | 低。只抄 schema 形状 |
| **13** | utility vs chat 调用策略分离 | `core/llm-request-policy.ts:14-33` | 旁路调用（标题/摘要）强制 `reasoningLevel:"off"` | 低 |
| **14** | 事件词表 + ring buffer resume | `server/routes/chat.ts` 事件表；`server/session-stream-store.ts` | 事件名可直接沿用；`streamId + seq + sinceSeq` 断线重放模式（Tauri 里也需要，窗口重载会断） | 中 |
| **15** | 工具自带 UI 渲染钩子 | `lib/pi-sdk/session-options.ts:140-145` | `renderCall` / `renderResult` 挂在工具定义上，前端不用写 switch | 低 |
| **16** | AccessLevel + OP_REQUIREMENTS 形状 | `lib/sandbox/path-guard.ts:24-37,195-208` | 四级枚举 + 操作→最低级别映射 + `realpath` 后单点 `check()` | 低 |
| **17** | 硬截断纯函数 | `core/compaction-utils.ts:27-54` | 不切开一个 turn（`isSplitTurn` → 退到 `turnStartIndex`）；纯函数无 IO 好测 | 低 |
| **18** | 文本模型的视觉降级 | `core/session-coordinator.ts:4857-4867` | 不支持视觉的模型，用另一个模型把图转文字 | 中（Papertable 若支持笔记内图片时有用） |

### 6.2 需要重新设计（Hana 的方案不足或不适用）

| 项 | Hana 现状 | Papertable 应该怎么做 |
|---|---|---|
| **★ Agent loop 本体** | 在闭源 `@earendil-works/pi-agent-core` 里，本仓库拿不到 | **自己写。** 只读双工具场景下 loop 很简单：`loop { resp = model(msgs); if (resp.toolCalls.empty) break; results = run(resp.toolCalls); msgs += results; }`。Rust 侧写，事件 emit 到前端 |
| **★ 迭代上限** | **完全没有**（`maxSteps` 等零命中） | **必须加。** 建议 `maxSteps = 8~12`；同一工具+同一参数重复调用计数上限；per-turn token 上限；触及上限时给模型一条"你已达到检索次数上限，请基于已有信息作答"的系统消息再要一次 final text（比直接掐断体验好得多） |
| **★ 成本熔断** | 只记账不熔断（`lib/llm/usage-ledger.ts`） | 记账层可抄 `normalizeLlmUsage()` 的字段别名表，但要加阈值中断 |
| **★ prompt-based 工具回退** | **不存在**，`supportsTools:false` 就是不能用工具 | 若要支持任意本地模型，必须自己实现。**且可以复用 `tool-protocol-sanitizer.ts` 的标签识别逻辑作为解析器**——把 Hana"当垃圾清洗"的东西改成"当备用协议解析"，这是 Papertable 能超越 Hana 的点 |
| **429 / 限流退避** | 只映射成 `LLM_RATE_LIMITED`，无重试 | 加指数退避（本地模型场景弱化，云端必须） |
| **持久化格式** | JSONL 真相 + SQLite 索引，代价是 4.2 那一整套读时修复 | Papertable 已有 SQLite。**建议 SQLite 单一真相**（messages / tool_calls 表 + 外键），事务保证不会出现"孤儿 toolResult"，直接绕掉 `session-health.ts` / `tool-pairing.ts` 那一大类修复代码。这是 Papertable 相对 Hana 的结构性优势，别放弃 |
| **压缩** | LLM 摘要 + 缓存保留 + 硬截断降级 | v1 只做硬截断（抄 `computeHardTruncation`）。只读笔记问答很少长到需要 LLM 摘要 |

### 6.3 与"只读本地边界"直接冲突 / 应当明确不移植

| 项 | 位置 | 冲突点 |
|---|---|---|
| **OS 级沙盒三件套** | `lib/sandbox/`（22 文件，Seatbelt / bubblewrap / Windows restricted token） | 为"agent 能跑任意命令 / 写文件"存在。Papertable 无写、无 exec，**沙盒的整个存在理由消失**。留 `AccessLevel` 概念，扔掉实现 |
| **PathGuard 的策略表** | `lib/sandbox/policy.ts`（BLOCKED_FILES / READ_ONLY_HOME_DIRS / READ_WRITE_AGENT_DIRS 等 8 层） | 8 层判定是为多 agent 目录 + 工作区 + 插件缓存的复杂布局。Papertable 只需一条规则：**"在笔记库根下 ⇒ READ_ONLY；其它一切 ⇒ BLOCKED"**。八层退化成两行 |
| 副作用工具 | `lib/tools/` 里的 exec_command / write / edit / write_stdin / computer / browser / cron / dm / channel / install_skill / stage_files / notify / update_settings | 全部不要。`SIDE_EFFECT_TOOLS`（`core/session-permission-mode.ts:34-55`）那张表可以当"不要做什么"的清单读 |
| 多 Agent / subagent / workflow | `lib/tools/subagent-tool.ts`、`lib/subagent-*.ts`、`lib/workflow/`、`lib/session-collab/` | 扇出与递归防护（`SUBAGENT_BLOCKED_TOOLS`）是多 agent 的产物。单 agent 笔记问答不需要 |
| 插件系统 | `packages/plugin-*`、`plugins/`、`core/plugin-*.ts`（十余文件）、`PLUGINS.md`（63KB） | 两级权限模型、iframe ticket、HTTP 路由注入、Session Bus。**引入插件等于引入任意代码执行，直接摧毁只读边界。** 明确不做 |
| SKILLS 生态 | `lib/skills/`、`lib/skill-bundles/`、`skills2set/`、`core/skill-manager.ts` | 从 GitHub 安装可执行技能。与只读边界正面冲突 |
| 外部平台桥接 | `lib/bridge/`（27 文件）、`lib/channels/` | Telegram / 飞书 / QQ / 微信。本地优先笔记应用不需要，且是攻击面 |
| 人格 / 记忆写入 | `lib/ishiki-templates/`、`lib/identity-templates/`、`lib/memory/` 的写路径、`lib/diary/` | 记忆**写入**意味着 agent 有持久副作用。若 Papertable 要做记忆，应存在独立的 app 数据库而非笔记库，且和"笔记只读"分开表述。**`fact-store.ts` 的 FTS5/n-gram 读路径值得抄，写路径的语义要重新想** |
| Electron 特有设施 | `desktop/`、Hono server、`/mobile/` PWA、LAN access key、`core/device-registry.ts`、`core/ws-auth-ticket.ts` | Tauri 有自己的 IPC（`invoke` + `emit`），不需要在应用内跑 HTTP server。**但 4.3 的事件词表和 4.2 的 resume 语义要保留**，Tauri 的 `emit` 通道同样会因窗口重载而丢事件 |
| 媒体管线 | `core/media*`、`core/computer-use/`、`core/speech-recognition*`、`lib/browser/` | 与笔记无关 |

### 6.4 三条最重要的结论

1. **Loop 抄不到，加固层才是资产。** 别期待从这个仓库拿到 agent loop——它不在。真正的价值在 `lib/pi-sdk/stream-guard.ts`、`lib/tool-protocol-sanitizer.ts`、`server/routes/chat.ts` 的空回复检测、`core/session-coordinator.ts` 的中止顺序纪律、`lib/memory/fact-store.ts` 的 CJK FTS 方案。这五处是别人用 issue 号换来的（代码里 `#521` / `#1285` / `#1624` 处处可见），Papertable 可以零成本继承。

2. **Hana 缺的正是 Papertable 最需要的：预算与步数上限。** 一个 40 万行量级的成熟 agent 产品**完全没有 `maxSteps`**，只靠 20 分钟空闲看门狗兜底。这不是可以效仿的地方，而是必须补的空缺。只读双工具场景下模型陷入检索循环的概率不低（找不到答案就反复换关键词搜），一定要有硬上限 + "达到上限请基于已有信息作答"的优雅收尾。

3. **Papertable 的架构约束反而能消掉 Hana 大量复杂度，别把它丢掉。** Hana 的 `session-health.ts` / `tool-pairing.ts` / `_repairOrphanToolHistory` 那一整套读时修复，根源是"append-only JSONL + 第三方 loop 在错误路径上写半条记录"。Papertable 用 SQLite 事务写一个回合，这类问题从存在层面被消除。同理，只读边界让 `lib/sandbox/` 的 22 个文件退化成两行判断。**这些是设计红利，不要为了"像参考实现"而重新引入复杂度。**

---

## 附：本报告引用的关键文件速查

| 文件 | 行数 | 为什么重要 |
|---|---|---|
| `lib/pi-sdk/stream-guard.ts` | 246 | ★ 模型行为不端的降级（最值得抄） |
| `lib/tool-protocol-sanitizer.ts` | — | ★ 工具协议碎片识别（NFKC / 零宽 / 全角） |
| `lib/pi-sdk/index.ts` | 273 | SDK 单点收口适配器 + 纪律声明 |
| `lib/pi-sdk/session-options.ts` | 189 | 工具定义形状 + 执行幂等 + SDK 版本分支 |
| `lib/pi-sdk/tool-outcome-adapter.ts` | 46 | `isError` 位提升 + 历史失败投影 |
| `lib/tools/tool-result.ts` | 32 | 统一工具结果形状 |
| `core/session-coordinator.ts` | 8088 | 回合驱动（`:4859` prompt、`:5650` 强制释放、`:4711-4780` 读时修复、`:2207` 事件订阅） |
| `server/routes/chat.ts` | 1700+ | ★ 事件翻译层（`:324` 看门狗常量、`:937` 看门狗、`:1225-1360` 事件映射、`:1619-1700` turn_end） |
| `server/session-stream-store.ts` | — | ring buffer + 字段级压缩 + resume |
| `core/session-health.ts` | — | 会话健康度 + 孤儿 toolResult 修复 |
| `core/compaction-utils.ts` | — | 硬截断纯函数 |
| `core/provider-compat.ts` + `core/provider-compat/` | 407 + 18 文件 | 单点归一化 + 逐 provider 补丁 |
| `core/llm-client.ts` | 708 | 非流式 utility 调用 + 错误分类 |
| `core/llm-request-policy.ts` | — | utility vs chat 策略分离 |
| `shared/model-capabilities.ts` | — | 能力元数据 schema |
| `core/session-permission-mode.ts` | — | 四档权限 + 工具语义分组 + "拦截而非剥离" |
| `lib/sandbox/path-guard.ts` + `policy.ts` | — | AccessLevel / OP_REQUIREMENTS / 单点 check |
| `lib/memory/fact-store.ts` | — | ★ SQLite + FTS5 + CJK n-gram + LIKE 降级 |
| `lib/memory/memory-search.ts` | — | 标签 + FTS 两级检索 |
| `lib/search/session-search.ts` | — | 词法打分 + snippet |
| `lib/pi-sdk/search-tools.ts` | 744 | 沙盒化 grep / find |
| `core/events.ts` | 439 | ThinkTagParser / MoodParser / CardParser 流式解析器 |
| `lib/llm/usage-observer.ts` | 200 | 跨 provider usage 字段归一 |
