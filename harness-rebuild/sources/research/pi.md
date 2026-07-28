# Pi Harness 架构分析报告

> 分析对象：`https://github.com/earendil-works/pi`（commit `c820aa2`，version `0.82.1`）
> 分析目的：为 Papertable（Tauri + SQLite + React/TS，本地优先，**只读**笔记库，工具仅 `search_notes` / `read_notes`）评估「借鉴 / 复用」Pi harness 的可行性。
> 分析方式：只读代码审计，未修改任何文件。

---

## 0. 结论摘要（TL;DR）

Pi 的架构比它「极简系统提示词」的名声更有价值。真正值得关注的发现有四条：

1. **`@earendil-works/pi-agent-core` 是运行时无关的。** 整个 `packages/agent/src/` 目录（约 10k 行）**没有任何一处 `node:` 导入**，唯一的 Node 适配器被隔离在 `src/harness/env/nodejs.ts` 并通过独立的 `./node` 子路径导出。所有文件 I/O 和 shell 都走 `ExecutionEnv` 接口的依赖注入。
2. **浏览器可打包性由 CI 强制保证。** `scripts/check-browser-smoke.mjs` 用 esbuild 以 `platform: "browser"` 打包 agent core + 单个 provider，并断言产物中**不含**其他 provider SDK（`@aws-sdk`、`openai`、`@google/genai`…）和完整模型目录。这直接回答了 Tauri WebView 前端能否直接依赖它的问题：**能**。
3. **循环驱动层极小且无状态。** `agent-loop.ts` 全文 793 行，是一个纯函数式驱动器。终止条件全部外置为回调，**内置没有 max-turns、没有 token/成本预算、没有 no-progress 检测**。
4. **分层清晰，可以「按层取用」。** 从 `agentLoop()` 纯函数 → `Agent` 类 → `AgentHarness` → `AgentSession` → TUI/RPC，共五层，每层都可以作为集成切入点。

对 Papertable 最关键的**风险提示**：Pi 所谓的「read-only 工具集」（`createReadOnlyTools`）**并非无副作用** —— 其中的 `grep` / `find` 工具会 `spawn` 子进程，甚至会在 `rg` 不存在时**自动下载二进制**（`src/core/tools/grep.ts:172`）。详见 [§8 安全边界冲突清单](#8-安全边界冲突清单)。

---

## 1. 包结构（PACKAGE STRUCTURE）

### 1.1 Monorepo 布局

许可证：**MIT**（`LICENSE`，Copyright 2025 Mario Zechner）。语言：**TypeScript 全栈**，ESM only（`"type": "module"`），`engines.node >= 22.19.0`。构建用 `tsgo`（`@typescript/native-preview`），Lint 用 Biome，测试用 Vitest。

| 包名 | 目录 | 定位 | 可分离性 |
|---|---|---|---|
| `@earendil-works/pi-ai` | `packages/ai` | LLM 统一 API、provider 抽象、模型目录 | **库**（浏览器可用） |
| `@earendil-works/pi-agent-core` | `packages/agent` | Agent 循环、harness、session、compaction | **库**（浏览器可用，运行时无关） |
| `@earendil-works/pi-coding-agent` | `packages/coding-agent` | `pi` CLI 应用：工具集、TUI、RPC、扩展系统 | **应用**（部分可分离） |
| `@earendil-works/pi-tui` | `packages/tui` | 终端 UI 库（差分渲染） | 库（但对 Papertable 无用） |
| `@earendil-works/pi-server` | `packages/server` | 实验性 server：进程管理 + IPC | 实验性 |
| `@earendil-works/pi-storage-*` | `packages/storage/sqlite-node` | SQLite session 后端 | 库（Node 绑定） |
| `@earendil-works/pi-evals` | `packages/evals` | 评测（private） | 内部 |

### 1.2 五层架构（决定复用切入点）

```
第 5 层  modes/interactive (TUI) · modes/rpc · modes/print      ← 应用，终端绑定
第 4 层  AgentSession (coding-agent/src/core/agent-session.ts)   ← 应用编排，含扩展系统
第 3 层  AgentHarness (agent/src/harness/agent-harness.ts, 1084行) ← session 持久化 + compaction + hooks
第 2 层  Agent 类 (agent/src/agent.ts, 577行)                     ← 可变状态 + steering/followUp 队列
第 1 层  agentLoop() (agent/src/agent-loop.ts, 793行)             ← 无状态纯驱动器
```

`packages/agent/src/index.ts` 是运行时无关入口；`packages/agent/src/node.ts` 仅额外导出 `NodeExecutionEnv`。

### 1.3 运行时依赖

`packages/agent/package.json` 依赖极轻：

```json
"dependencies": {
  "@earendil-works/pi-ai": "^0.82.1",
  "diff": "8.0.4",
  "ignore": "7.0.5",
  "typebox": "1.1.38",
  "yaml": "2.9.0"
}
```

`packages/ai` 依赖较重（`@anthropic-ai/sdk`、`openai`、`@google/genai`、`@mistralai/mistralai`、`@aws-sdk/client-bedrock-runtime`、`@opentelemetry/api`、`partial-json`、`typebox`），但**全部通过 `api/lazy.ts` 的 `lazyApi()` 惰性加载**，打包时可 tree-shake（见 §3.4）。所有外部直接依赖都锁定精确版本（`scripts/check-pinned-deps.mjs` 强制）。

---

## 2. Agent 主循环（AGENT LOOP）

核心文件：`packages/agent/src/agent-loop.ts`。

### 2.1 双层循环结构

`runLoop()`（`agent-loop.ts:155-275`）是双层嵌套循环：

```
外层 while(true)                          ← 处理「本该停止但又来了新消息」
  内层 while(hasMoreToolCalls || pendingMessages.length > 0)
    1. emit turn_start
    2. 注入 pendingMessages（steering）
    3. streamAssistantResponse()          ← 唯一的 LLM 调用点
    4. 若 stopReason 为 error/aborted → 立即 agent_end 返回
    5. 过滤出 toolCall content blocks
    6. 执行工具（sequential / parallel）
    7. emit turn_end
    8. prepareNextTurn?()                 ← 可换 model / thinkingLevel / context
    9. shouldStopAfterTurn?() → agent_end 返回
    10. pendingMessages = getSteeringMessages?()
  getFollowUpMessages?() 非空 → 回到内层；否则 break
emit agent_end
```

### 2.2 消息装配（message assembly）

装配发生在 `streamAssistantResponse()`（`agent-loop.ts:281-372`），管线为：

```
context.messages (AgentMessage[])
  → config.transformContext?()   // AgentMessage[] → AgentMessage[]，用于剪枝/压缩/注入
  → config.convertToLlm()        // AgentMessage[] → Message[]，过滤掉 UI-only 消息
  → Context { systemPrompt, messages, tools }
  → config.getApiKey?(provider)  // 每次调用重新解析，支持短期 OAuth token
  → streamFunction(model, llmContext, options)
```

设计要点：`AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`（`types.ts:319`），宿主应用可通过 TypeScript **declaration merging** 注入自定义消息类型（如 UI 通知、artifact），再在 `convertToLlm` 里决定是过滤掉还是转成 user message。这是 Pi 上下文工程的关键机制：**UI 可见的消息集合 ≠ 模型可见的消息集合**。

流式期间，partial message 被就地写入 `context.messages` 数组尾部并逐次替换（`agent-loop.ts:321`、`337`），最终由 `response.result()` 的终态替换。

### 2.3 工具执行

`executeToolCalls()`（`agent-loop.ts:411-426`）按 `config.toolExecution`（默认 `"parallel"`）或任一工具的 `executionMode === "sequential"` 分派。并行模式（`executeToolCallsParallel`）的语义很讲究：

- **准备阶段串行**（逐个 `prepareToolCall`，含校验和 `beforeToolCall` 门控）
- **执行阶段并发**（`Promise.all`）
- `tool_execution_end` 按**完成顺序**发出
- 而 tool-result **消息**按 assistant 原始顺序发出（`agent-loop.ts:543-548`）

这一区分对 UI 很重要：进度事件可乱序（体验更实时），但写入 transcript 的顺序确定（保证可重放）。

每个工具调用的生命周期钩子：`prepareArguments`（原始参数兜底修正）→ `validateToolArguments`（TypeBox schema 校验）→ `beforeToolCall`（可 `{ block: true }` 拦截）→ `execute`（可通过 `onUpdate` 推送 partial）→ `afterToolCall`（可逐字段覆写结果）。

---

## 3. 终止状态全枚举（TERMINATION TAXONOMY）

### 3.1 LLM 层 StopReason

`packages/ai/src/types.ts:382`，共 6 个值：

```typescript
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
```

流事件协议把它们分成两个终态（`types.ts:502-503`）：

```typescript
| { type: "done";  reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage }
```

各 provider 把原生 reason 映射到这 6 个值。以 Anthropic 为例（`packages/ai/src/api/anthropic-messages.ts:1322-1345`）：`end_turn`→`stop`、`max_tokens`→`length`、`tool_use`→`toolUse`、`refusal`→`error`（带 `errorMessage`）、`pause_turn`→`stop`、`stop_sequence`→`stop`、`sensitive`→`error`，未知值直接 `throw`（fail-fast，不静默降级）。

### 3.2 循环层退出路径（穷举）

| # | 触发条件 | 代码位置 | 行为 |
|---|---|---|---|
| 1 | `stopReason === "error"` | `agent-loop.ts:196` | emit `turn_end`(空 toolResults) + `agent_end`，立即 return |
| 2 | `stopReason === "aborted"` | `agent-loop.ts:196` | 同上 |
| 3 | 无 tool call 且无排队消息 | `agent-loop.ts:174` 循环条件 | 退出内层 → 查 follow-up → `break` → `agent_end` |
| 4 | 批次内**所有** tool result 都置 `terminate: true` | `agent-loop.ts:582-584` `shouldTerminateToolBatch` | `hasMoreToolCalls = false`，正常收尾 |
| 5 | `config.shouldStopAfterTurn()` 返回 true | `agent-loop.ts:247-257` | emit `agent_end` 返回，**不**再轮询 steering/follow-up |
| 6 | `signal.aborted` | `agent-loop.ts:478`、`516`、`535` | 中断工具批次；剩余调用不执行 |
| 7 | `stopReason === "length"` 且**无** tool call | 落入 #3 | 静默结束（**注意：不会被标记为异常终止**） |

**关键设计决策：`stopReason === "length"` 且**有** tool call 时不终止，而是把该批次内所有工具调用全部转为错误结果**（`failToolCallsFromTruncatedMessage`，`agent-loop.ts:381-406`）。理由写在注释里（`agent-loop.ts:374-380`）：流式 tool-call 参数用「尽力而为的 JSON 抢救解析器」收尾，因此被截断的消息可能产出**参数能通过 schema 校验但内容静默不完整**的调用 —— 执行它们是危险的。反馈给模型的文本是：

> `Tool call "X" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`

这是一个很值得借鉴的正确性细节。

### 3.3 错误如何反馈给模型

**所有**工具错误都被转成正常的 `ToolResultMessage`（`isError: true`，`content` 为纯文本），永不抛出到循环外。错误文本来源穷举：

| 错误来源 | 反馈文本 | 位置 |
|---|---|---|
| 工具不存在 | `Tool ${name} not found` | `agent-loop.ts:611` |
| schema 校验失败 / `prepareArguments` 抛错 | `error.message` | `agent-loop.ts:660` |
| `beforeToolCall` 拦截 | `beforeResult.reason` 或 `Tool execution was blocked` | `agent-loop.ts:639` |
| 准备阶段被 abort | `Operation aborted` | `agent-loop.ts:632`、`647` |
| `execute()` 抛异常 | `error.message` | `agent-loop.ts:701` |
| `afterToolCall` 抛异常 | `error.message` | `agent-loop.ts:744` |
| 输出截断（见 §3.2） | 上述 re-issue 提示 | `agent-loop.ts:396` |

工具契约是「**失败请抛异常，不要自己把错误编码进 content**」（`types.ts:388`），由循环统一归一化。

### 3.4 预算与无进展检测：**不存在**

全仓库检索 `maxTurns` / `maxIterations` / `noProgress` / `turnBudget` 均无命中。`packages/agent` 内置**没有**：

- 最大轮数限制
- token / 成本预算上限（虽然 `Usage.cost` 被完整计算，见 §6.3）
- 重复工具调用 / 无进展循环检测

唯一的止损手段是宿主实现 `shouldStopAfterTurn` 回调。**Papertable 若复用循环层，必须自己实现轮数上限**，否则模型可能无限循环。

存在的是**provider 层重试**：`RetryPolicy`（来自 `pi-ai`）用于传输/限流错误，harness 通过 `retryCallbacks()`（`agent-harness.ts:268`）发出 `retry_scheduled` / `retry_attempt_start` / `retry_finished` 事件，CLI 暴露为 `set_auto_retry` RPC 命令。

---

## 4. Provider / 能力层（PROVIDER & CAPABILITY）

### 4.1 Provider 接口

`packages/ai/src/models.ts:75-120`：

```typescript
export interface Provider<TApi extends Api = Api> {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly headers?: ProviderHeaders;
  readonly auth: ProviderAuth;                          // apiKey / oauth / 两者
  getModels(): readonly Model<TApi>[];                  // 同步，静态或已缓存
  refreshModels?(context): Promise<void>;               // 可选，动态 provider
  filterModels?(models, credential): readonly Model<TApi>[];
  stream<T extends TApi>(model, context, options?): AssistantMessageEventStream;
  streamSimple(model, context, options?): AssistantMessageEventStream;
}
```

10 个 API 家族（`types.ts:16-26`）：`openai-completions`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`google-generative-ai`、`google-vertex`、`bedrock-converse-stream`、`mistral-conversations`、`pi-messages`。**37 个静态 provider**（`packages/ai/src/providers/*.models.ts` 计数）注册在 `providers/all.ts`，另有纯动态 provider（如 `radius`）无静态目录条目。

### 4.2 能力处理：**静态生成表，无运行时探测**

**没有任何 handshake / probe 逻辑。** 能力信息全在 `Model<TApi>` 类型里（`types.ts:749-776`）：

```typescript
export interface Model<TApi extends Api> {
  id: string; name: string; api: TApi; provider: ProviderId; baseUrl: string;
  reasoning: boolean;                    // 是否原生支持思考
  thinkingLevelMap?: ThinkingLevelMap;   // pi 的 7 级 thinking 映射到 provider 原生值；null 表示该级不支持
  input: ("text" | "image")[];           // 多模态输入能力
  cost: ModelCost;                       // 分档计价
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: /* 按 api 泛型分派的兼容性覆盖表 */;
}
```

模型目录是**构建期生成 + 远程 hydrate** 的两段式设计：

- `src/models.generated.ts`（118 行）只做 re-export 汇总
- 每个 provider 一个 8 行的薄封装，例如 `src/providers/anthropic.models.ts`：
  ```typescript
  import values from "./data/anthropic.json" with { type: "json" };
  import { flattenModelCatalog, type ModelCatalog } from "../model-catalog.ts";
  export const ANTHROPIC_MODELS: ModelCatalog<typeof values, "anthropic"> =
    flattenModelCatalog("anthropic", values);
  ```
- `src/providers/data/*.json` **不入库**（`.gitignore:11`），由 `npm run hydrate:model-data`（`generate-models.ts --strict --data-only`）从远程目录拉取

`compat` 是能力差异的第二道防线 —— 针对 OpenAI 兼容端点的行为漂移提供显式覆盖开关，如 `supportsDeveloperRole`、`supportsReasoningEffort`、`maxTokensField`、`supportsUsageInStreaming`（`types.ts:509-562`），默认从 `baseUrl` 自动推断。

### 4.3 无原生 tool calling 的模型：**不支持，无模拟层**

检索 `emulat` / `pseudo.?tool` / `xml tool` / `textToolCall` 全仓库零命中。**Pi 不提供 prompt-based / XML tool-call 模拟**。不支持原生 tool calling 的模型不在目录内，或直接无法用于工具场景。

对 Papertable：如果只打算接 Claude / GPT / Gemini 这类一线模型，这不是问题；如果想接本地小模型（llama.cpp 等），需自己实现模拟层。注意 `packages/coding-agent/src/extensions/llama` 存在，说明本地模型走的是扩展路径。

### 4.4 流式事件协议

`types.ts:491-503`，11 个事件类型。设计亮点：**每个增量事件都携带完整的 `partial: AssistantMessage` 快照**，消费方无需自己累积状态：

```typescript
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start";     contentIndex: number; partial }
  | { type: "text_delta";     contentIndex: number; delta: string; partial }
  | { type: "text_end";       contentIndex: number; content: string; partial }
  | { type: "thinking_start" | "thinking_delta" | "thinking_end"; contentIndex: number; ...; partial }
  | { type: "toolcall_start"; contentIndex: number; partial }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial }
  | { type: "toolcall_end";   contentIndex: number; toolCall: ToolCall; partial }
  | { type: "done";  reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error";           error: AssistantMessage };
```

`toolcall_delta` 传原始 JSON 字符串片段，用 `partial-json` 增量解析。`StreamFn` 契约（`packages/agent/src/types.ts:28-32`）明确规定：**不得抛异常或返回 rejected promise**，所有失败必须编码进流内的 `error` 事件 + 终态 message 的 `stopReason`。

### 4.5 浏览器可打包性（CI 强制）

`scripts/check-browser-smoke.mjs` 做两件事：

1. 用 `platform: "browser"` 打包 `scripts/browser-smoke-entry.ts`（导入 `Agent`、`InMemorySessionRepo`、compaction/skills/truncate 等工具函数），验证浏览器面向的导出里没有 Node-only 导入。
2. 打包 `agent-treeshake-smoke-entry.ts`（只选 `anthropicProvider`），断言产物：
   - **不包含** `packages/ai/src/compat.ts`、`models.generated.ts`、`providers/all.ts`（`check-browser-smoke.mjs:70-75`）
   - 模型目录 JSON **只有** `anthropic.json`（`:87-91`）
   - provider SDK **只有** `@anthropic-ai/sdk`，不含 `@aws-sdk`/`openai`/`@google/genai`/`@mistralai`（`:93-107`）

这条 CI 检查是 Papertable 的直接背书：**只要显式导入单个 provider（`@earendil-works/pi-ai/providers/anthropic`）而非 `providers/all`，产物体积和 Node 耦合都可控。**

唯一的 Node 硬绑定是 **OAuth**：`src/auth/oauth/anthropic.ts` 用 `node:http` 起本地回调服务器，非 Node 环境直接抛错。Tauri 应用应改用 Rust 侧处理 OAuth 回调，或只用 API key。

---

## 5. State / Trace / 事件（STATE & TRACE）

### 5.1 Session 是 append-only 事件溯源树

`packages/agent/src/harness/types.ts:453-464`，11 种 entry 类型：

```typescript
export type SessionTreeEntry =
  | MessageEntry | ThinkingLevelChangeEntry | ModelChangeEntry | ActiveToolsChangeEntry
  | CompactionEntry | BranchSummaryEntry | CustomEntry | CustomMessageEntry
  | LabelEntry | SessionInfoEntry | LeafEntry;
```

核心思想：**上下文不是存储的，而是推导出来的**。`Session.buildContext()`（`session/session.ts:188`）从当前 leaf 沿 parent 指针回溯到 root **或最近一次 compaction**（`getPathToRootOrCompaction`，`types.ts:512`），再投影成 `SessionContext { messages, thinkingLevel, model, activeToolNames }`。因此：

- **可恢复**：给定 session 标识即可重建
- **可分叉/分支**：`SessionRepo.fork(source, { entryId, position: "before" | "at" })`（`types.ts:518-537`）；`Session.moveTo()` 切换 leaf
- **模型/thinking/工具集变更本身就是 entry**，历史回溯时能还原「当时用的是哪个模型」

### 5.2 存储可插拔（对 Papertable 极其关键）

`SessionStorage` 接口（`types.ts:498-514`）有三个实现：`JsonlSessionStorage`、`InMemorySessionStorage`、SQLite（`packages/storage/sqlite-node`，含 migrations）。

关键设计：**JSONL 实现自身不碰 Node fs**，而是接受一个窄化的注入依赖（`session/jsonl-storage.ts:13`）：

```typescript
type JsonlSessionStorageFileSystem = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;
```

Papertable 可以直接实现 `SessionStorage` 打到自己的 SQLite（通过 Tauri command），或实现这个 4 方法的 `Pick` 来复用 JSONL 逻辑。

### 5.3 事件系统（三个层次）

**第 1 层 — `AgentEvent`**（`packages/agent/src/types.ts:422-437），循环原语，10 个事件：
`agent_start`、`agent_end`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`。

**第 2 层 — `AgentHarnessOwnEvent`**（`harness/types.ts:715-740`），24 个 harness 事件：
`queue_update`、`save_point`、`abort`、`settled`、`before_agent_start`、`context`、`before_provider_request`、`before_provider_payload`、`after_provider_response`、`tool_call`、`tool_result`、`session_before_compact`、`session_compact`、`session_before_tree`、`session_tree`、`retry_scheduled`、`retry_attempt_start`、`retry_finished`、`model_update`、`thinking_level_update`、`resources_update`、`tools_update`。

其中一批是**可返回值的拦截型 hook**，由 `AgentHarnessEventResultMap`（`harness/types.ts:793-820`）做类型级映射，例如 `before_agent_start` 可改写 messages/systemPrompt，`context` 可替换 messages，`before_provider_payload` 可改写原始请求体，`tool_call` 可 `{ block: true }`，`tool_result` 可打补丁。这是一套设计得相当好的中间件模型。

**第 3 层 — RPC 协议**（`packages/coding-agent/src/modes/rpc/rpc-types.ts`，289 行），stdin/stdout 上的 JSONL。`RpcCommand` 约 30 条命令（`rpc-types.ts:22-73`），含 `prompt` / `steer` / `follow_up` / `abort` / `get_state` / `set_model` / `compact` / `switch_session` / `fork` / `clone` / `get_entries` / `get_tree` / `bash` 等；`RpcResponse` 为按 `command` 判别的联合，成功/失败用 `success: true | false` 区分。

**这条 RPC 通道是 Papertable 的「零移植」备选方案**：Tauri 可以把 `pi` 当子进程 spawn，用 JSONL 驱动。但注意 `RpcExtensionUIRequest`（`rpc-types.ts:238-273`，select/confirm/input/editor/notify/setStatus/setWidget）假设了终端 UI，需要适配层。`packages/server` 在此之上再包一层进程管理 IPC（`server/src/ipc/protocol.ts`），但**明确标注 experimental**。

### 5.4 错误分类体系

Pi 的错误建模值得直接借鉴：**不用异常，用 `Result<T, E>` + 稳定错误码**（`harness/types.ts:24-53`）。

```typescript
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
```

6 组错误码（全部是后端无关的稳定字符串枚举）：

| 错误类 | 错误码 | 位置 |
|---|---|---|
| `FileError` | `aborted`/`not_found`/`permission_denied`/`not_directory`/`is_directory`/`invalid`/`not_supported`/`unknown` | `types.ts:150-173` |
| `ExecutionError` | `aborted`/`timeout`/`shell_unavailable`/`spawn_error`/`callback_error`/`unknown` | `types.ts:176-193` |
| `CompactionError` | `aborted`/`summarization_failed`/`invalid_session`/`unknown` | `types.ts:197-208` |
| `BranchSummaryError` | `aborted`/`summarization_failed`/`invalid_session` | `types.ts:212-223` |
| `SessionError` | `not_found`/`invalid_session`/`invalid_entry`/`invalid_fork_target`/`storage`/`unknown` | `types.ts:226-243` |
| `AgentHarnessError` | `busy`/`invalid_state`/`invalid_argument`/`session`/`hook`/`auth`/`compaction`/`branch_summary`/`unknown` | `types.ts:246-265` |

`FileSystem` 和 `Shell` 的接口注释明确规定实现**永不 throw**，所有失败编码进 `Result`。

---

## 6. 上下文管理（CONTEXT MANAGEMENT）

### 6.1 Compaction

`packages/agent/src/harness/compaction/compaction.ts`（880 行）+ `branch-summarization.ts`（275 行）。

触发判据极简（`compaction.ts:263-266`）：

```typescript
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

默认参数（`compaction.ts:174-178`）：`enabled: true`、`reserveTokens: 16384`、`keepRecentTokens: 20000`。

流程：`prepareCompaction()` 用 `findCutPoint()` 从最新往回累加 token 直到达到 `keepRecentTokens`，定出切点（并对「turn 中途切断」做 `isSplitTurn` 特殊处理，保留 `turnPrefixMessages`）→ `generateSummary()` 用**另一次 LLM 调用**生成摘要（`maxTokens = min(0.8 * reserveTokens, model.maxTokens)`）→ 写入 `CompactionEntry`。

摘要 prompt 输出一个固定的结构化模板（`compaction.ts` 附近）：`## Progress`（Done / In Progress / Blocked）、`## Key Decisions`、`## Next Steps`、`## Critical Context`，并要求「保留精确的文件路径、函数名、错误信息」。存在 `SUMMARIZATION_PROMPT` 与 `UPDATE_SUMMARIZATION_PROMPT` 两版 —— 二次压缩时是**增量更新已有摘要**而非从头重写，这是个好设计。

另外 compaction 会跨 entry 追踪 `FileOperations { read, written, edited }`（`harness/types.ts:~`），把文件操作集合独立于 token 预算之外全量收集（`branch-summarization.ts:200`），保证压缩后不丢「碰过哪些文件」这类关键状态。

### 6.2 系统提示词设计

`packages/coding-agent/src/core/system-prompt.ts:121-138`。默认 prompt 主体**只有约 18 行**，这就是「minimal system prompt」名声的来源：

```
You are an expert coding assistant operating inside pi, a coding agent harness.
You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
<每个工具一行 snippet>

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
<按实际可用工具动态生成的 bullet>
```

三个值得借鉴的细节：

1. **工具清单按实际启用的工具动态生成**，且「只有调用方提供了 one-line snippet 的工具才出现在清单里」（`system-prompt.ts:80-84`）。
2. **Guidelines 按工具可用性条件生成**（`system-prompt.ts:104-106`：只有在有 bash 且没有 grep/find/ls 时才加「用 bash 做文件操作」），并用 Set 去重。默认只有两条硬编码：`Be concise in your responses`、`Show file paths clearly when working with files`。
3. **skills 段落只在 `read` 工具可用时才注入**（`system-prompt.ts:155`）—— 因为 skills 机制依赖模型自己去读文件。

拼装顺序：主体 → `appendSystemPrompt` → `<project_context>` → skills → `Current working directory: ...`。`customPrompt` 可完全替换主体但保留后续段落。

### 6.3 Skills 与 AGENTS.md

**Skills** 采用渐进式披露（progressive disclosure），符合 agentskills.io 约定。系统提示词里只放 name/description/location 的 XML 索引（`packages/agent/src/harness/system-prompt.ts:3-25`），**内容不预加载**，由模型按需自己 `read`：

```
The following skills provide specialized instructions for specific tasks.
Read the full skill file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory ...
<available_skills>
  <skill><name>…</name><description>…</description><location>…</location></skill>
</available_skills>
```

`disableModelInvocation` 标志可让 skill 从模型可见列表中隐藏但仍允许应用显式调用。

**AGENTS.md 发现逻辑**（`packages/coding-agent/src/core/resource-loader.ts:67-121`）：候选文件名 `["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]`，先加载全局 `agentDir`，再从 cwd **一路向上遍历到文件系统根**，用 `unshift` 保证祖先在前、最近的在后（即更具体的覆盖更泛的），并用 `seenPaths` 去重。每个文件包成 `<project_instructions path="...">`。

### 6.4 成本核算

`packages/ai/src/models.ts:639-660` 的 `calculateCost()`：支持**分档计价**（`ModelCost.tiers`，按 input token 阈值选最高匹配档）、cache read/write 分开计价，以及 Anthropic 1 小时缓存写入按 **2× input 费率**的特殊规则。`Usage` 含 `input`/`output`/`cacheRead`/`cacheWrite`/`cacheWrite1h`/`reasoning`/`totalTokens` + 嵌套 `cost` 对象。

---

## 7. 复用判定（REUSE VERDICT）

判定口径：**(a) 可直接作为依赖复用** / **(b) 移植模式、重写代码** / **(c) 不适用**。

| 组件 | 位置 | 判定 | 理由与说明 |
|---|---|---|---|
| **循环驱动器** `agentLoop()` | `agent/src/agent-loop.ts` | **(a) 直接复用** | 793 行纯函数，零 Node 依赖，终止策略全外置。CI 已验证浏览器可打包。**但必须自己实现 `shouldStopAfterTurn` 做轮数上限**（§3.4）。可在 Tauri WebView 前端直接跑。 |
| **`Agent` 类**（状态 + 队列） | `agent/src/agent.ts`（577 行） | **(a) 直接复用** | 提供 `isStreaming` / `streamingMessage` / `pendingToolCalls` / `errorMessage` 等 UI 需要的可观察状态，以及 steering/followUp 队列。React 只需订阅事件重渲染。 |
| **Provider 抽象** | `ai` 包 | **(a) 直接复用**（选择性导入） | 必须用 `@earendil-works/pi-ai/providers/<name>` 而非 `providers/all`，否则拖入 5 个 SDK。OAuth 需绕过（走 Rust 侧或只用 API key）。 |
| **能力表 / 模型目录** | `ai/src/models.generated.ts` + hydrate | **(b) 移植模式** | 静态生成 + 远程 hydrate 的两段式很聪明，但 Papertable 大概只需要 3-5 个模型，维护整套 hydrate 流水线不划算。建议手写一张小的 `Model` 常量表，**复用 `Model<TApi>` 的字段结构**（`reasoning` / `thinkingLevelMap` / `input` / `cost` / `contextWindow`）。 |
| **流式事件协议** `AssistantMessageEvent` | `ai/src/types.ts:491-503` | **(a) 直接复用** | 「每个 delta 都带完整 partial 快照」这一点对 React 渲染特别友好，可省掉前端累积逻辑。 |
| **事件 / trace 模型** | `agent/src/types.ts:422-437` + `harness/types.ts:715-740` | **(a) 第 1 层直接复用；(b) 第 2 层选择性移植** | 10 个 `AgentEvent` 直接可用。24 个 harness 事件对笔记应用多数无意义（retry / model_update / tree），建议只挑 `before_agent_start`、`context`、`tool_call`、`tool_result` 四个拦截点的**模式**。 |
| **终止分类体系** | §3 | **(b) 移植模式** | `StopReason` 6 值 + `Result<T,E>` + 6 组稳定错误码是本仓库最值得抄的部分，且几乎零成本（纯类型）。特别推荐照抄「工具错误一律转成 `isError: true` 的 tool result 喂回模型，永不 throw 出循环」这条不变式，以及 `length` + tool call 时全批次作废的处理。 |
| **Compaction** | `agent/src/harness/compaction/` | **(b) 移植模式** | 触发判据（`contextTokens > contextWindow - reserveTokens`）和「增量更新已有摘要」的两版 prompt 值得抄。但 `FileOperations { read, written, edited }` 追踪是编码 agent 专属的，对 Papertable 应替换为「引用过哪些笔记 ID」。 |
| **Session 事件溯源树** | `agent/src/harness/session/` | **(a) 可复用 / (b) 亦可移植** | `SessionStorage` 是 14 方法接口，Papertable 可实现它打到自己的 SQLite。「上下文由 leaf→root/compaction 回溯推导而非直接存储」的思想强烈推荐。若只需线性会话不需分叉，(b) 更省事。 |
| **`ExecutionEnv` 抽象** | `harness/types.ts:291-373` | **(b) 移植模式**（见下方警告） | `FileSystem`（17 方法）+ `Shell`（2 方法）。对 Papertable 而言这个接口**方向不对** —— 它抽象的是「文件系统」，而 Papertable 的资源是 SQLite 里的笔记。应该借鉴的是**「能力通过注入的 env 接口提供、且实现永不 throw 只返回 `Result`」这个模式**，而不是这个具体接口。 |
| **系统提示词组装** | `coding-agent/src/core/system-prompt.ts` | **(b) 移植模式** | 逻辑简单（130 行），但内容是编码 agent 专属（提到 bash/edit/write、pi 自身文档路径）。抄结构：动态工具清单 + 条件化 guidelines + 分段拼装。 |
| **Skills 渐进式披露** | `agent/src/harness/system-prompt.ts` | **(a) 直接复用** | `formatSkillsForSystemPrompt()` 是 25 行纯函数、零依赖。**但前提是模型有办法读取 skill 文件** —— Papertable 若无 `read` 工具，需改成把 skill 内容通过 `read_notes` 或专门工具暴露。 |
| **内置工具**（read/bash/edit/write/grep/find/ls） | `agent/src/harness/tools/`、`coding-agent/src/core/tools/` | **(c) 不适用** | 全部面向文件系统。Papertable 用 `noTools: "all"` + `customTools` 注入自己的两个工具。 |
| **TUI 库** | `packages/tui` | **(c) 不适用** | 终端差分渲染，Papertable 是 React。 |
| **RPC 协议 / 子进程模式** | `coding-agent/src/modes/rpc/` | **(b) 移植模式**，或作为**过渡方案 (a)** | 30 条命令的 JSONL 协议设计良好，Tauri 可直接 spawn `pi` 驱动。但这会把整个编码 agent（含 bash 工具）拉进产品，与只读安全边界严重冲突。建议只借鉴协议形状用于 Rust↔WebView 通信。 |
| **扩展系统** | `coding-agent/src/core/extensions/` | **(c) 不适用** | 基于 jiti 运行时加载任意 TS 模块 —— 对本地优先笔记应用是不必要的攻击面。Papertable 的工具集是固定的两个，编译期注册即可。 |
| **`packages/server`** | `server/src/` | **(c) 不适用** | 明确 experimental，且 Tauri 自带 IPC。 |

---

## 8. 安全边界冲突清单

Papertable 的约束是：**只读笔记库、无 shell、无文件写入**。以下是审计出的冲突点，按严重程度排列。

### 🔴 严重：`createReadOnlyTools` 名不副实

`packages/coding-agent/src/core/tools/index.ts:177-184`：

```typescript
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
  return [createReadTool(...), createGrepTool(...), createFindTool(...), createLsTool(...)];
}
```

这里的 "read-only" 只意味着**不修改文件**，不意味着无副作用：

- `grep` 工具 **spawn 子进程**：`src/core/tools/grep.ts:5` 导入 `child_process`，`:221` `spawn(rgPath, ...)`
- 更严重的是 `src/core/tools/grep.ts:172` 的 `await ensureTool("rg", true)` —— **`rg` 不存在时会自动下载二进制**
- `find` 工具同样 spawn `fd`（`src/core/tools/find.ts:4`、`:255`）
- `read` / `ls` 给的是**整个 cwd 的文件系统读权限**，不是笔记库边界

**结论：Papertable 绝不能使用 `createReadOnlyTools`。** 必须用 `noTools: "all"` 从零开始，只注入自己的 `search_notes` / `read_notes`。

### 🟡 中等：`ExecutionToolContext` 强制携带 Shell

`packages/agent/src/harness/tools/tool-context.ts`：

```typescript
export interface ExecutionToolContext {
  env: ExecutionEnv;   // = FileSystem & Shell
}
```

`ExecutionEnv` 是 `FileSystem`（含 `writeFile`/`appendFile`/`remove`/`createTempDir`）**与** `Shell`（含 `exec`）的交集类型。这意味着即使只想用 `read` 工具，其 context 类型也要求存在 `exec()` 方法。可以用返回 `err(new ExecutionError("shell_unavailable", ...))` 的桩实现绕过（错误码正好预留了这个值），但**类型层面没有「只读能力」的表达**。

若要复用 `AgentHarness` 的 tool context 机制，建议**自定义 `TContext` 泛型**（`AgentHarnessTool<TContext>` 本身是泛型的，`harness/types.ts:99-112`），例如 `{ notes: NotesReader }`，完全不引入 `ExecutionEnv`。这是干净的做法。

### 🟡 中等：session 持久化默认要写盘

`JsonlSessionStorage` 需要 `writeFile` / `appendFile`。Papertable 若用 SQLite 存会话，应直接实现 `SessionStorage` 接口（14 方法）而非 `FileSystem`。或者原型阶段先用 `InMemorySessionStorage` / `InMemorySessionRepo`（已在浏览器 smoke test 中验证可用）。

### 🟡 中等：Compaction 需要额外的 LLM 调用与网络

`generateSummary()` 会发起一次独立的 LLM 请求。对「本地优先」定位来说这是可接受的（主对话本身也要联网），但要注意：**压缩是隐式的额外成本和延迟**，且 `reserveTokens: 16384` 的默认值对小上下文窗口模型偏大。

### 🟢 轻微：其他

- **OAuth 需要 Node**（`ai/src/auth/oauth/anthropic.ts:41-42` 起 `node:http` 服务器）→ Tauri 应在 Rust 侧处理回调。
- **`AGENTS.md` 向上遍历到文件系统根**（`resource-loader.ts:106-115`）→ 若复用此逻辑，会读取笔记库之外的任意祖先目录文件。Papertable 不应复用。
- **扩展系统用 jiti 运行时加载任意 TS**（`core/extensions/loader.ts`）→ 任意代码执行面，不要引入。
- **`packages/coding-agent` 的默认系统提示词硬编码了 pi 自身文档路径**（`system-prompt.ts:131-138`）→ 必须用 `customPrompt` 完全替换。

---

## 9. 推荐集成方案

基于上述分析，给 Papertable 的建议是 **「取第 1–2 层，重写第 3–4 层，丢弃第 5 层」**：

```
┌─ React UI ──────────────────────────────────────────┐
│  订阅 AgentEvent（10 个事件）驱动渲染                  │
├─ 自研薄 harness ────────────────────────────────────┤
│  · 轮数上限（shouldStopAfterTurn）← 必须自己写         │
│  · compaction 触发判据（移植 shouldCompact 公式）      │
│  · SessionStorage → Tauri command → SQLite            │
├─ 直接依赖 @earendil-works/pi-agent-core ────────────┤
│  · agentLoop() / Agent 类                            │
│  · AgentEvent / AgentMessage / AgentTool 类型         │
│  · Result<T,E> + 错误码体系                          │
│  · formatSkillsForSystemPrompt()（可选）              │
├─ 直接依赖 @earendil-works/pi-ai（选择性导入）────────┤
│  import { anthropicProvider } from                    │
│    "@earendil-works/pi-ai/providers/anthropic"        │
│  ← 绝不 import providers/all                          │
└──────────────────────────────────────────────────────┘

工具层：noTools 不适用（不走 coding-agent），直接给 AgentContext.tools
        传入 [searchNotesTool, readNotesTool]，自定义 TContext = { notes: NotesReader }
```

必须自己补上的三件事（Pi 没有提供）：

1. **轮数 / 成本预算上限** —— 通过 `shouldStopAfterTurn` 实现，Pi 内置完全没有。
2. **无进展检测** —— 例如同一工具带相同参数连续调用 N 次即中断。
3. **只读能力的类型级表达** —— 用自定义 `TContext` 替代 `ExecutionToolContext`，让「无法写入」成为编译期保证而非运行时约定。

最值得直接照抄的三个模式（成本几乎为零，收益明显）：

1. **工具错误一律转为 `isError: true` 的 tool result 喂回模型，永不抛出到循环外**（§3.3 的 7 条错误路径）。
2. **`stopReason === "length"` 且有 tool call 时，整批作废并要求模型重发**（`agent-loop.ts:374-406`）—— 这是个真实的正确性陷阱。
3. **`AgentMessage` 与 LLM `Message` 分离 + `convertToLlm` 投影** —— 让 UI 可见的 transcript 与模型可见的上下文解耦，这是 Pi「干净的上下文工程」的技术本质。
