# dg-ai-notes 调研报告：作为 Agent Harness 参考的价值评估

> 调研对象：`https://github.com/buchidonggua/dg-ai-notes`（分支 HEAD，commit `fdf9ccd`）
> 调研目的：为 **Papertable**（本地优先笔记应用；笔记库**只读**；工具仅 `search_notes` / `read_notes`；已知故障：模型持续返回 tool_calls 而不产出最终文本）设计 agent harness 提供先例。
> 调研日期：2026-07-27。**只读调研，未修改仓库任何文件。**

---

## 0. 结论速览（先看这段）

**这个仓库是"笔记/教程"，不是 harness 实现。** 它是中文博主"冬瓜"对 **Pi-Agent SDK**（`earendil-works/pi`，TypeScript）的源码拆解教程，共 10 章、约 45 万字符，TS/Python 双版本对照。仓库里**没有任何可运行的 harness 代码**，唯一的可执行代码是一个 ~150 行的教学 notebook。

对 Papertable 而言，它的价值和局限非常不对称：

| | 评价 |
|---|---|
| **强项** | 提供了一套**成熟的循环终止分类学**（5 种 stopReason、4 条退出路径）、**事件模型**（10 种事件 4 层嵌套 + 同步屏障）、**上下文工程分层防护**（截断/拉模式/压缩/分支摘要）、**消息双层设计**（内富外严）。这些是可直接迁移的骨架。 |
| **致命空白** | **它完全没有回答 Papertable 的核心问题。** 全文 grep `maxTurns` / `最大轮` / `死循环` / `无限循环` / `强制最终` / `tool_choice` —— **零命中**。没有轮数上限、没有无进展检测、没有强制收尾、没有两阶段 plan/act 编排、没有工具预算。 |
| **反向风险** | 第 5 章的核心哲学"错误即消息、让模型自己纠错、循环永不中断"在**没有预算和无进展检测配合时，恰恰会放大** Papertable 现在遇到的失败模式。作者全程未讨论这个反面。 |

**一句话**：把它当**架构骨架的参考**很好，当**失控防护的参考**则是空的——那部分 Papertable 必须自己设计。

---

## 1. 仓库定性：它到底是什么

### 1.1 目录结构

```
README.md                        仓库说明（教程导航）
CONTRIBUTING.md / LICENSE        代码 MIT，文档 CC-BY-SA-4.0
pi-agent/
  README.md                      教程内容地图
  docs/python/  第1..10章 + _chapter-design/第11章设计文档   ← 主体内容
  docs/typescript/ 第1..10章                                 ← 同内容 TS 版
  docs/*/assets/  ~30 组 .svg + .html 配图
  notebooks/agent-loop.ipynb     唯一可执行代码（教学用，~150 行）
  web/                           Astro 静态站（阅读器 UI，非 harness）
```

字符量分布（Python 版）：第 3 章 Agent Loop 61KB（最大）、第 5 章工具系统 52KB、第 10 章会话管理 41KB、第 4/6/8 章各约 35KB、第 9 章 30KB、第 7 章 27KB。

### 1.2 定性结论

- **是**：一份高质量的**二手技术笔记**。特点是大量标注 `文件:行号`（如 `agent-loop.ts:196-200`），并给出 Python 改写对照。作者对 Pi v0.80.2 做了逐函数走读。
- **不是**：harness 实现、可复用库、或 Pi 官方文档。`pi-agent/web/` 是阅读网站（Astro + Svelte 组件），与 agent 运行时无关。
- **注意**：所有"源码"都是**引用/改写**，不是本仓库的代码。任何行号在采纳前应回 `earendil-works/pi` 核实。作者本人在多处标注了版本不一致（见 §8.3）。
- 唯一可执行代码 `pi-agent/notebooks/agent-loop.ipynb` 的 API_KEY 是 32 位占位符（无数字、无真实密钥特征），**无凭据泄露**。

---

## 2. 核心框架一：Trace / Turn 与循环终止分类学

**来源：`pi-agent/docs/python/第3章-Agent-Loop-让模型转动起来的引擎.md`（本报告最重要的单一文件）**

### 2.1 三种"用模型"的模式（§一）

作者给的分类表（L79-85）对 Papertable 有直接的定位价值：

| 维度 | 直接调用 | Workflow | Agent Loop |
|------|---------|----------|------------|
| 决策者 | 用户 | 你的代码 | 模型 |
| 模型调用次数 | 1 次 | N 次（代码控制） | **不确定（模型控制）** |
| 核心工作 | 写提示词 | 设计流程 | 定义工具和循环 |

> **对 Papertable 的启示**：`search_notes → read_notes → 回答` 其实是一条**已知形状的流程**。作者的分类暗示：如果流程形状已知，Workflow 模式（代码控制步数）比 Agent Loop 更可控。Papertable 现在的 bug 本质是"用 Agent Loop 做了一件更适合半 Workflow 化的事"。这是本报告 §9 的主要建议之一。

### 2.2 Trace / Turn 的精确定义（§二）

- **Trace** = 从 `agent_start` 到 `agent_end` 的整个过程，包含多个 Turn。
- **Turn** = **一次模型调用 + 这次调用触发的所有工具执行**（L109-111）。一个 Turn 只有一次模型调用；把工具结果喂回去再调模型，那是**下一个** Turn。
- 若模型一口气要求 3 个工具，这 3 个都在**同一个** Turn 内执行。
- 首轮 `turn_start` 在 `runAgentLoop()` 入口发出，`runLoop()` 内用 `firstTurn` 标志跳过首圈，避免重复（L173）。

> **对 Papertable**：这个定义直接给出了"轮数预算"的计量单位。"最多 8 次 `search_notes`" 是错的计量口径（一个 Turn 可以并行发 5 个 search）；正确口径应同时限制 **Turn 数**和**累计工具调用数**。

### 2.3 stopReason：5 个值，2 个来源（§三，核心）

作者反复强调一个认知（L241）：**模型不会说"我要停了"**。`stopReason` 虽挂在返回值上，但值来自两个不同地方：

**模型 API 真正返回的 3 种**：

| stopReason | 含义 |
|---|---|
| `toolUse` | 模型输出了工具调用 JSON |
| `stop` | 生成自然终止，无工具调用 |
| `length` | 达到 maxTokens 上限，被截断 |

**框架流式层 catch 块注入的 2 种**（模型 API 永不返回）：

| stopReason | 含义 | 注入点 |
|---|---|---|
| `error` | 网络断、API 报错 | `output.stopReason = signal?.aborted ? "aborted" : "error"` |
| `aborted` | 用户主动中止（AbortSignal） | 同上 |

跨 provider 归一化在第 4 章：Anthropic `end_turn → stop`、`tool_use → toolUse`，各家命名统一成 Pi 自己的 5 值术语（`第4章-模型调用...md` §《第三层：翻译器》）。

> **这是本仓库最值得直接抄的一件事**：把异常和用户取消**塞进同一个枚举**，让循环只有一个判断点。Papertable 应定义完全相同的 5 值枚举，并额外增加 harness 自己注入的值（见 §9）。

### 2.4 真正驱动循环的条件（L262-293，关键细节）

作者特意纠正了一个常见误解（L293）：

> 实际驱动循环的**不是** `stopReason === "toolUse"`，而是 `toolCalls.length > 0 && !terminate`。

推论有两条，都很重要：
- 即使 `stopReason === "length"`（被截断），只要 content 里有 toolCall 块，**循环仍会执行工具**；
- 即使 `stopReason === "toolUse"`，如果工具结果都设 `terminate: true`，**循环也会停**。

内层循环条件是 `while (hasMoreToolCalls || pendingMessages.length > 0)`。

作者对此的哲学表述（L266）值得引用：**"不是模型在说'我完成了'，而是我们在说'你没要工具，那就当你完成了'。"**

### 2.5 四条退出路径（L327-332）

| 退出路径 | 触发条件 | 说明 |
|---|---|---|
| **正常退出** | `stop`/`length` + 无 followUp + 无 pendingMessages | 最常见 |
| **硬停止** | `error`/`aborted` | 立即 `turn_end` + `agent_end` 后 `return`，**连工具都不执行、连 followUp 都不检查**（fail fast，L941-947） |
| **外部钩子停** | `shouldStopAfterTurn()` 返回 true | 上下文快满、达到最大 Turn 数等 |
| **工具终止** | 一批工具结果**全部** `terminate: true` | 用 `every` 不是 `some` |

> ⚠️ **作者自相矛盾处**：L290 代码注释写"任何一个工具 terminate 则停止"，L332 表格写"全部 terminate，是 every 不是 some"。两处冲突，采纳前须回源码核实。

### 2.6 内核 + 叠加架构（§四、§五）

作者最有价值的方法论贡献：**区分"所有 Agent 都需要的内核"与"产品功能的按需叠加"**（L385-396）。

最简 Loop 只需十几行（L367-381）：调模型 → 无 toolCall 则 return → 有则执行工具、结果喂回 → 循环。

Pi 的 coding-agent 在此之上叠加四样：

| 真实需求 | 叠加设计 | 位置 |
|---|---|---|
| 用户在 Agent 工作期间又输入指令 | **steering 消息注入**（紧急插队） | 内层循环开头 + 每圈结尾各检查一次 |
| 系统想在完成后追加任务 | **外层 followUp 循环**（同 Trace 内续命） | 外层 `while(true)` |
| 不同复杂度用不同模型 | **prepareNextTurn 钩子**（可换 model/context/thinkingLevel） | `turn_end` 之后 |
| 上下文快满需压缩 | **shouldStopAfterTurn 钩子**（安全阀） | prepareNextTurn 之后 |

**steering vs followUp 对比**（L1137-1143）：steering 是"开会时有人递纸条——紧急，先看"；followUp 是"开完会翻信箱——不急但要处理"。

作者的判据（洋葱图说明 L1169）：**"剥掉任何一层，里层仍能跑——这是判断'内核是否被污染'的试金石。"**

> **对 Papertable**：`shouldStopAfterTurn` 是**唯一**能从外部掐断循环的内核级钩子，也是实现轮数预算/无进展检测最自然的挂载点。但注意作者把它归为"叠加"、明说"最简 Loop 不需要它"——**对 Papertable 这个判断是错的**，见 §9.2。

### 2.7 流式"原地替换"（§4.4 阶段 D，L851-922）

一个精巧且直接可抄的 UI 设计：
1. `start` 事件时把一个**空壳** AssistantMessage `append` 进 `context.messages`；
2. 每个 `*_delta` 事件用 `context.messages[-1] = partial` **原地覆盖最后一条**（消息**数量不变**，内容在"长大"）；
3. `done` 时用最终完整消息替换。

目的是 UI 能逐字渲染，而不是让用户盯几秒空白。配套设计（第 4 章）：**每个 AI 层事件都携带 `partial: AssistantMessage` 完整快照**，所以消费者做"原地替换"而非自己拼增量。

> **对 Papertable UI**：可以无脑用最新快照重渲染，不需要在前端维护增量拼接状态。

### 2.8 prompt cache 的三个打点位置（L831-849）

Pi 在 Anthropic 请求的三处打 `cache_control: {type:"ephemeral"}`：system prompt 末尾、**最后一个 tool**、**最后一条 user message**（rolling cache，随最新消息推进）。命中链路：

```
Turn 1: 写入 [system + tools] → 写入 [messages §1]
Turn 2: 命中 [system + tools] → 命中 [messages §1] → 写入 [messages §2]
```

作者澄清两点：cache 是**内容寻址**的（看字节不看对象 identity，所以每轮重建 wrapper 对象无害）；`tools` 是 Anthropic 协议的**独立顶层字段**、位置在 messages 之前，稳定前缀在前的设计本身就为 cache 服务。OpenAI 走另一条路：`prompt_cache_key: sessionId`。

> **对 Papertable 高度相关**：只读笔记库意味着 `system + tools` 是极稳定前缀，cache 收益结构性地好。rolling cache 打在最后一条 user message 上这个技巧值得抄。

---

## 3. 核心框架二：工具系统与"错误即消息"

**来源：`pi-agent/docs/python/第5章-工具系统-Agent的手脚是怎么被管住的.md`**

> **术语纠偏**：README 宣传的"五步管道 = 定义/注册/拦截/执行/回收"与正文不符。第 5 章 §二 的五步实际是：
> **`prepareArguments` → `validateToolArguments`（Schema 校验）→ `beforeToolCall`（权限拦截）→ `tool.execute` → `afterToolCall`（结果后处理）**
> 三章中**没有**"注册"环节的独立论述——工具只是以列表传给 Loop，靠 `tools.find(t => t.name === tc.name)` 查名，查不到直接产出 `Tool xxx not found` 错误结果。

### 3.1 三层类型（§一）

`Tool{name, description, parameters}`（纯模型适配层 `pi-ai`，只是"名片"）→ `AgentTool`（加 `label`/`prepareArguments`/`execute`/`executionMode`）→ `ToolDefinition`（产品层，再加 `promptSnippet`/`renderCall`/`renderResult` 和第 5 个 execute 参数 `ctx: ExtensionContext`）。`wrapToolDefinition` 用闭包注入 ctx，让 Agent Loop 永远看不到 ExtensionContext。分层理由是**依赖范围隔离**——不能让模型适配层依赖终端 UI 库。

Schema 用 TypeBox `TSchema`（作者类比 pydantic）。校验失败被 `prepareToolCall` 的 try-catch 吃掉，**工具永远收不到类型错误的参数**。

### 3.2 并行 vs 串行：一票否决（§三）

策略：`toolCalls.some(tc => tool.executionMode === "sequential")` 或全局 `config.toolExecution === "sequential"`，**任一成立则整批串行**。

并行时**三阶段**（`第3章` L993-1002 亦有）：
```
阶段1 - 准备（顺序）：A → B → C     ← 含验证和 beforeHook，不能并行
                                       （万一 B 被拦截，C 就不该执行）
阶段2 - 执行（并行）：A、B、C 同时   ← 只有 tool.execute 并行
阶段3 - 事件（有序）：end 按完成顺序；result 按【调用顺序】
                                       ← result 顺序必须与 ToolCall 一致，
                                         否则 LLM 收到的上下文是错的
```

**一个反直觉的实证**（§三 末尾）：v0.80.2 的 7 个内置工具**都没声明 `executionMode`**，全部默认 parallel；Edit 的安全靠工具内部的 `withFileMutationQueue`（`file-mutation-queue.ts:32-61`）。即"一票否决"机制在内置工具里**基本处于休眠状态**。

> **对 Papertable**：两个工具都只读，天然可并行，这块基本免费。但**阶段 3 的"result 按调用顺序返回"是硬要求**，不能因为并行就乱序追加 tool_result。

### 3.3 错误防线：6 类错误 → 1 种产物（§四）

6 类错误（工具未找到 / `prepareArguments` 抛 / Schema 失败 / `beforeToolCall` 阻止 / `execute` 抛 / `afterToolCall` 抛）**统一收敛成一条 `isError: true` 的 ToolResultMessage**，追加进历史，下一轮发给模型，**循环不中断**。

作者的哲学表述（§四）：**"错误信息是给模型的反馈，不是给框架的终止信号。"**

两层分工很值得抄：
- **工具内部**主动识别已知错误并写具体描述——Read 附文件总行数、Edit 附路径、Bash 把"已输出内容 + 超时/中止/退出码"打包成新异常；
- **框架兜底层**只搬运 `str(error)`，`createErrorToolResult` 本体只有三行。

另有 `acceptingUpdates` 标志位：execute 一 settle 就关闸，丢弃迟到的 `onUpdate` 回调；catch 里先 `await gather(update_events)` 把进度事件发完再编码错误，避免 UI 出现"先报错后吐进度"的错乱序列。

> ⚠️ **对 Papertable 的风险提示**：这套"错误即消息、让模型自己换路径重试"的设计，**在没有预算和无进展检测配合时会直接放大**"模型无限重试工具"的失败模式。作者全程鼓励模型失败后重试，**从未讨论这个反面**。Papertable 采纳"错误即消息"时必须同时上预算。

### 3.4 唯一的早停原语：`terminate`

`afterToolCall` 可字段级覆盖结果，用途包括脱敏/审计/修错/**早停（返回 `{terminate: true}`）**。这是本仓库里**唯一一个"从工具侧强制结束循环"的原语**。

另一条干预通路是扩展系统的 `tool_call` 事件返回 `{block: true, reason}`（对应 `beforeToolCall`）。

### 3.5 明确的空白

第 5 章通篇**没有**：max iterations、单会话工具调用次数上限、框架级 timeout（只有 Bash **工具自己**识别 `timeout:` 前缀错误串，`bash.ts:390-407`）、重复调用检测。结果截断也完全不在第 5 章，全在第 8 章。

---

## 4. 核心框架三：上下文工程的分层防护

**来源：`pi-agent/docs/python/第8章-上下文工程-让有限窗口装下无限对话.md`**

### 4.1 两层防护、四个机制（§二）

| 层 | 机制 | 解决什么 | 触发频率 |
|---|---|---|---|
| 输入侧 ① | 工具输出截断 | 单条太大 | **每次工具调用** |
| 输入侧 ② | 系统提示词动态组装 | 项目规范注入 | 每轮 prompt |
| 历史侧 ③ | Compaction | 线性对话过长 | 阈值触发 |
| 历史侧 ④ | 分支摘要 | 分支跳转遗忘 | 切换会话树分支时 |

作者的核心论点（§八.1）：**"没有任何单一机制能搞定所有上下文问题……每层都只解决自己擅长的问题，互不替代。"** 举例：Compaction 调得再激进，单条 80KB 的 read 结果没有截断"连一轮都撑不过"。

### 4.2 工具输出截断（§三，Papertable 直接相关）

- **双重限制先触者胜**：`DEFAULT_MAX_LINES = 2000` + `DEFAULT_MAX_BYTES = 50KB`；另有 `GREP_MAX_LINE_LENGTH = 500` 单行限长。
- **双向策略**：`truncateHead` 保留开头（用于 read——文件头 import/接口密度高）；`truncateTail` 保留末尾（用于 bash——错误栈在末尾）。
- **UTF-8 边界安全**：`truncateStringToBytesFromEnd` 逐字符累加字节，遇到 4 字节 emoji 当不可分割整体处理，避免切出 `�`。
- **单行就超限**：取该行末尾 maxBytes 并置 `lastLinePartial: true`。
- **`TruncationResult`** 记录 `truncated / truncatedBy / totalLines / totalBytes / outputLines / outputBytes`。

**最值得抄的一点——逃生通道**（§三《截断后的提示》）：截断后往输出里追加一行

```
[Showing lines 6501-8500 of 8500. Full output: /tmp/pi-bash-xxx.log]
```

**这行也进上下文**，等于给模型一个"想看全的自己去 read"的指针。即**"摘要 + 指针"而非"全量"**。

> **对 Papertable 高度相关**：`read_notes` 读长笔记时应完全照抄这个模式——截断 + 明确告知"这是第 X-Y 行，共 Z 行，用 `read_notes(id, offset=…)` 继续"。**但要小心**：给模型一个"可以继续读"的指针，本身就是在鼓励它再发一轮工具调用——这与 Papertable 的失控问题直接冲突。指针必须配预算。

### 4.3 系统提示词组装（§四）

- `loadProjectContextFiles`（`resource-loader.ts:85-123`）在每层目录找 `AGENTS.md`/`CLAUDE.md`（大小写都试），从 cwd **向上递归到根**，再加 `~/.pi` 全局一份。合并顺序：全局 → 祖先（外到内）→ cwd。
- XML 包装：`<project_context>` + `<project_instructions path="...">`（`system-prompt.ts:154-161`），带 path 让模型区分优先级。
- **完整骨架 9 段**：角色定位 → 工具列表 → guidelines → Pi 文档路径 → appendSystemPrompt → `<project_context>` → `<available_skills>` → **Current date** → **cwd**。后两项在**末尾**，作者称其为"上下文工程的基本元数据"（处理"昨天"这类相对时间、相对路径）。

### 4.4 拉模式懒加载：Skills（§四 + §八.3，Papertable 最相关的单一想法）

每个 skill 是一个可能几千字的 `SKILL.md`。Pi 的方案（`skills.ts:335-361`）是**只把轻量清单放进 system prompt，全文按需 read**：

```xml
<available_skills>
  <skill>
    <name>test-setup</name>
    <description>How to run tests for this project</description>
    <location>/path/to/skills/test-setup/SKILL.md</location>
  </skill>
</available_skills>
```

清单顶上一句指令构成全部契约：*"Use the read tool to load a skill's file when the task matches its description"*。

| 方案 | Token 开销 | 信息密度 |
|---|---|---|
| 全文塞（推模式） | 10 skill × 2000 字 ≈ 50K token | 大部分无关 |
| 懒加载（拉模式） | 10 skill × 4 行 ≈ 500 token | 精准命中才展开 |

作者的抽象（§八.3）：

| 维度 | 推模式 | 拉模式 |
|---|---|---|
| Token 开销 | 全部预付 | 用时才付 |
| 信息密度 | 大部分无关 | 精准命中 |
| LLM 主动性 | 被动接收 | 主动选择 |
| 适用场景 | **必须知道**的信息 | **可能用到**的信息 |

**核心洞察**：*"当 LLM 有工具调用能力时，'工具'本身就是上下文工程的载体。"*

> **对 Papertable**：这就是 `search_notes` → `read_notes` 两阶段的**原型**。Papertable 甚至可以更进一步：把笔记库的**目录/标签清单**（轻量）直接放进 system prompt，让模型在很多情况下**跳过 `search_notes` 直接 `read_notes`**——少一轮就少一次失控机会。
> **但必须注意**：这是"拉模式"，驱动方是**模型自己**，框架**不做阶段切换**。它不是 §5 意义上的强制两阶段编排。

### 4.5 加法 + 减法：上下文"塑形"（§八.2）

作者论点：上下文工程不是单纯压缩，而是**塑形**——"同等 token，结构化的信息密度更高"。反例：把 50 轮原始文本拼成一坨扔给 LLM，体积没问题但效果远不如"结构化摘要 + 近期消息"。

### 4.6 全景链路（§七）

```
用户输入 → [1] buildSystemPrompt → [2] 消息进 context → [3] Agent Loop
        → [4] toolCall → [5] 执行 → [6] ★截断 → [7] 结果进历史
        → …循环… → [8] agent_end → [9] shouldCompact 判定 → [10] 切分支时 Branch Summarization
```

注意 **[9] 挂在 `agent_end` 上**——压缩发生在两个 Trace 之间，不在对话进行中。

---

## 5. 核心框架四：Compaction（最接近"强制收尾"的原型）

**来源：`pi-agent/docs/python/第9章-上下文压缩-当对话太长怎么办.md`**

### 5.1 触发（§二）

`shouldCompact = enabled && contextTokens > contextWindow - reserveTokens`，代入 `200,000 − 16,384 = 183,616`。Token 用 `estimateTokens`（`compaction.ts:256-296`）按 `ceil(chars/4)` 估。

两种场景：**预防性**（超阈值，常态）与**应急性**（API 已报 overflow，先压再重试，兜底）。

关键时序（§一末）：**压缩发生在两轮之间，挂在 `agent_end` 事件上**，不在对话进行中。

### 5.2 切点选择（§三）

- `findValidCutPoints`：**user 和 assistant 合法，toolResult 不合法**——协议硬约束，toolResult 必须紧跟 toolCall。
- 语义关键：**切点是"保留区的第一条"而非"被切掉的最后一条"**。
- `findCutPoint` **从最新往回累积** token，达到 `keepRecentTokens`（20K）后取最近的合法切点。理由："最近的上下文最重要"。
- 为什么不禁止 assistant 切点：只允许 user 切点会导致保留区过大、**压缩根本压不动**（§五）。

### 5.3 保留 vs 摘要（§四）

切点之后原样保留；切点之前序列化后**一次 LLM 调用**生成**固定 6 section**：

```
Goal / Constraints & Preferences / Progress(Done / In Progress / Blocked)
/ Key Decisions / Next Steps / Critical Context
```

作者对固定模板的论证（§四、§八）：*"自由文本摘要有一个失败模式：LLM 容易被'有趣的内容'吸引，花大篇幅描述某个技术细节，忘了记录用户的核心需求。固定 section 强制 LLM 在每个维度上至少扫一遍，把'易遗漏'变成'必须填'。"* Progress 下的 **Blocked** 子项专门记"卡住的事"，让新一轮优先解锁。

多次压缩用 `UPDATE_SUMMARIZATION_PROMPT` 做**增量更新而非重写**，理由是避免"摘要漂移的累积误差"。另单独维护 `<read-files>` / `<modified-files>` 跨压缩累积。

**Turn 分割处理**（§五）：assistant 切点会切断 Turn，被切断的前缀用轻量 **3 段格式**（Original Request / Early Progress / Context for Suffix）单独摘要，与主摘要 `Promise.all` **并行生成**后合并进同一 CompactionEntry。

### 5.4 ★ 这就是"强制收尾"的现成原型

**摘要调用是一次不带工具的独立 LLM 调用**：固定模板、固定 section、`maxTokens` 硬上限（Compaction 用 `min(0.8 × reserve, model.maxTokens)`，Branch Summary 写死 2048）。

> **这是全仓库对 Papertable 最有价值的一个可迁移实现**。它本质上就是一个"**强制产出结构化文本、不可能再调工具**"的 synthesize 阶段。Papertable 的"强制收尾"可以直接照这个形状实现，只是把 prompt 从"总结对话"换成"基于已读笔记回答用户问题"。见 §9.3。

### 5.5 作者点名的风险

- `chars/4` 对**中文严重低估**（1 汉字实际 1–2 token），纯中文场景会"以为没到阈值实际已近上限"。
- 压缩是**有损**的。
- 事件 `compaction_start(reason: manual|threshold|overflow)` / `compaction_end`，UI 可订阅显示"正在压缩上下文…"。

---

## 6. 核心框架五：消息系统（双层设计）

**来源：`pi-agent/docs/python/第6章-消息系统-Agent的记忆如何组织与传递.md`**

### 6.1 "7 种" = 3 标准 + 4 自定义

**LLM 只认的 3 种标准 `Message`**（`packages/ai/src/types.ts:322-408`）：
1. `UserMessage` — `content: str | (TextContent|ImageContent)[]`
2. `AssistantMessage` — `content: (TextContent|ThinkingContent|ToolCall)[]`，另带 api/provider/model/usage/**stopReason**/errorMessage
3. `ToolResultMessage` — `toolCallId` / `toolName` / `content` / `details` / `isError`

**coding-agent 的 4 种自定义**：
4. `BashExecutionMessage` 5. `CustomMessage` 6. `BranchSummaryMessage` 7. `CompactionSummaryMessage`

> **术语陷阱**：`AssistantMessage.content` 里的 3 种**内容块**（TextContent / ThinkingContent / ToolCall）是**另一个维度**，别和 7 种消息类型混淆。

### 6.2 双层动机："内富外严"（§三）

两个读者需求冲突：**UI 要结构化字段**（command/output/exitCode/cancelled/truncated），**LLM 只要一段扁平文本**。作者的论证：*"如果为了 LLM 把字段提前拍扁存进 UserMessage，UI 就再也拿不回结构化数据了。"*

自定义消息带来三个独立能力：UI 专用渲染、持久化恢复、**精细化可见性控制**（第三点最关键——*"标准消息做不到：一旦进了 messages 数组，convertToLlm 就一定会翻译它发给 LLM"*）。

### 6.3 两阶段管道（§五、§六）

```
context.messages: AgentMessage[]
  → [1] transformContext（可选，同层，AgentMessage[] → AgentMessage[]）   ← 压缩挂这里
  → [2] convertToLlm（必须，跨层，AgentMessage[] → Message[]）            ← 边界翻译官
  → streamFunction(model, llmContext)
```

分开的理由：换上下文策略只改 `transformContext`，换应用类型只改 `convertToLlm`，**换 provider 两个都不用改**（provider 协议翻译在第 4 章那一层）。默认 `convertToLlm` 就是一个 filter，只保留三种标准消息。

**可见性三级**（§七）：全可见 / **LLM 不可见**（`excludeFromContext=true`，数据仍在 `context.messages`、UI 照常渲染）/ 仅持久化。

> **对 Papertable**：`excludeFromContext` 这个设计很有用——比如"本轮已达工具预算"的警告可以只给 UI 看，或者反过来只给模型看而不显示给用户。

### 6.4 明确的空白：tool_use ↔ tool_result 配对

第 6 章只说了配对靠 `toolCallId` 字段，**完全没有讲**：孤儿 tool_use（有 tool_use 无 tool_result）会怎样、是否有校验器、被压缩/裁剪掉一半会不会破坏配对、provider 是否因此报 400。

唯一相关的约束来自第 9 章：`toolResult` 不能作为压缩切点。

> **对 Papertable：这块必须自己设计，Pi 笔记里没有先例可抄。** 而且这恰恰是 Papertable 最容易出 400 的地方——如果 harness 因为预算耗尽而**中途掐断**一批 tool_calls，就必然产生孤儿 tool_use。**结论：掐断必须在 Turn 边界，或为每个未执行的 tool_call 补一条合成 tool_result。**

---

## 7. 核心框架六：事件模型与 UI 进度

**来源：`pi-agent/docs/python/第7章-事件驱动-Agent的神经系统.md`**

### 7.1 10 种事件、4 层嵌套（`packages/agent/src/types.ts:413-428`）

| 层 | 事件 |
|---|---|
| L1 Agent | `agent_start` / `agent_end{messages}` |
| L2 Turn | `turn_start` / `turn_end{message, toolResults}` |
| L3 Message | `message_start{message}` / `message_update{message, assistantMessageEvent}` / `message_end{message}` |
| L4 Tool | `tool_execution_start{toolCallId,toolName,args}` / `tool_execution_update{...,partialResult}` / `tool_execution_end{...,result,isError}` |

分层理由：*"TUI 需要逐 token 渲染所以订阅 `message_update`；Session 管理器只看 `turn_end`。"* 配图补了一条正文没写的细节：**user message 只有 start/end，没有 update**。

Session 产品层再多 7 种（共 17）：`queue_update`、`compaction_start/end`、`auto_retry_start/end`、`session_info_changed`、`thinking_level_changed`，且 `agent_end` 被重载加了 `willRetry` 字段。

**分层判据（很好用）**：*"如果去掉某个事件后内核还能正常运行，它就属于外层。"*

### 7.2 同步屏障（§三，Pi 最有特色的设计）

`AgentEventSink = (event) => Promise<void> | void`。`processEvents`（`agent.ts:509-556`）做三件事：**先更新内部状态**（message_start/update 写 `streamingMessage`；message_end 清空并 `messages.push`）→ **再取 AbortSignal** → **最后 for 循环逐个 `await listener(event, signal)`**。

为什么 await：不 await 会导致"TUI 还没处理完 `message_start`，`message_update` 就来了 → UI 显示空消息或过时内容"。作者定性：*"await 不是为了通知，而是为了同步协商。代价是性能（必须等最慢的消费者），换来的是正确性。"*

**唯一例外**：`tool_execution_update` 先收集 Promise 数组、工具结束后 `Promise.all` 批量等。理由：*"进度更新是高频、低价值、可合并的；生命周期事件是低频、高价值的。"* 配 `acceptingUpdates` 闸门防止 settle 后的孤儿回调。

**监听器异常故意不包 try-except**（§四）——"保险丝"哲学，"监听器出错，运行就停下来，问题立刻可见"；但明确建议"你自己写 listener 务必自己 try-except"。第三方扩展则由框架隔离。

### 7.3 text delta 的 5 层旅程（§六）

```
LLM SSE → AI 层 EventStream.push（12 种 AssistantMessageEvent 之一）
       → Agent Loop 转成 message_update
       → Agent.processEvents 同步屏障
       → AgentSession._handleAgentEvent（通知扩展 → 分发 → 持久化）
       → TUI 渲染
```

**关键变换**：AI 层的 `text_delta`/`thinking_delta`/`toolcall_delta` **三种全部映射成 Agent 层单一的 `message_update`，原始事件通过 `assistantMessageEvent` 字段透传保留**。

> 这个设计很值得抄：**上层只需要"消息变了"，需要细节的消费者自己去挖透传字段。**

### 7.4 观察 vs 干预是两套机制

- **观察**：`session.subscribe(listener)`，签名 `(event, signal) => Promise<void>`，**无返回值，不能 mutate 或 veto**。
- **干预**：扩展系统 hooks——`tool_call` 事件返回 `{block: true, reason}` 阻止工具执行（对应 `beforeToolCall`）；`transformContext` 做上下文预处理。

### 7.5 UI 进度展示的现成模板（§五）

- 场景 1：订阅 `tool_execution_start` 打印 `🔧 {tool_name}({args前50字符})`；订阅 `tool_execution_end` 打印成功/失败。**这正好对应"正在搜索 / 正在读取笔记 X"。**
- 场景 4：SSE 转发到 Web 前端——订阅 `message_update` 发 delta、`agent_end` 关流。

> **对 Papertable 的重要局限**：这些事件展示的是**单个工具的内部进度**，**不是"整体任务还差多远"**。Papertable 若要显示"已用 3/8 次检索"，必须自己增加 harness 级事件（见 §9.5）。

---

## 8. 第三方视角：Provider 抽象、会话模型、以及仓库的可靠性

### 8.1 Provider 抽象（第 4 章）

**"翻译公司"三层**：第一层统一入口（前台，纯路由，只两行 `resolve_api_provider(model.api)` + `provider.stream(...)`，`compat.ts:237-247`）；第二层事件协议（标准报告模板）；第三层翻译器（翻译员）。配图 INSIGHT：*"前台不懂外语，翻译员不懂公司流程——两者靠标准报告协议连接。"*

**Provider 接口不是抽象基类，而是一个函数签名** `StreamFunction`（`types.ts:304-308`）：`(model, context, options?) -> AssistantMessageEventStream`。三条硬规则：输入相同、输出相同、**错误不抛异常而是 push `{type:"error"}` 事件**。作者称之为 **"协议 > 实现"设计法**，刻意不做 `BaseProvider` 继承，理由是"翻译器之间几乎没有共同点，连字段名都不一样"。

接入新 provider 三步：写翻译器 → `register_api_provider(...)` → 配置 `Model` 对象。注册表 `BUILTIN_APIS` 是 `api id → 翻译器实例` 的 dict（`compat.ts:172-206`）。"Agent Loop 一行都不用改"。

**线格式的四个差异维度**：消息格式（Anthropic `content:[{type:"text"}]` / OpenAI `content:"..."` 且**工具结果必须单独发 `{role:"tool"}` 消息**而 Anthropic 合并进 user 消息 / Google `parts:[{text}]` / Bedrock `content:[{text}]` 无 `type`）、流式传输、思考模式、缓存控制。

**流式策略**："有 SDK 就用（OpenAI、Google），没 SDK 就自己解析（Anthropic 裸 SSE，需自己处理 `event:`/`data:` 分离和 JSON 容错）"。**本章没有讨论非流式路径**——流式是唯一形态。

**ThinkingLevel**：统一枚举 `off/minimal/low/medium/high/xhigh`（正文说"五级"但列了六个值，原文不一致）。每个 `Model` 自带 `thinkingLevelMap`；`clampThinkingLevel()` **先向上找、找不到再向下**，理由"思考更多通常比更少安全"（`models.ts:410-429`）。

**一个隐蔽但有用的项**：`isContextOverflow()` 做**三重检测**——错误消息模式匹配、token 数对比、**输出为零 + length 停止**（`utils/overflow.ts:126-155`），把各家不同的静默截断表现统一捕获。

**⚠️ 第 4 章的空白**：**没有任何重试策略、退避算法、超时配置、HTTP 状态码分类（429/5xx）**。重试（`auto_retry_start/end`）被推到 **AgentSession 产品层**，且零实现描述。第 4 章正文只有一句"Agent Loop 收到后可以重试、降级、或报告给用户"——**这是可能性陈述，不是实现说明**。

### 8.2 会话模型（第 10 章）：Entry 分类学值得抄

Session Tree 是 append-only 树，节点**认父不认子**（`parentId`）——作者论证这是 append-only 的**必要条件**：若父节点持有 children 列表，新增分支就必须修改父节点，与不可变矛盾。

**9 种 Entry，按"对 LLM 调用的影响"分三组**（这个分类法很好用）：

| 组 | 类型 | 作用 |
|---|---|---|
| ① 进 LLM 上下文（4） | `MessageEntry` / `CustomMessageEntry` / `CompactionEntry` / `BranchSummaryEntry` | 变成 messages 数组的一项 |
| ② 影响后续调用（2） | `ModelChangeEntry` / `ThinkingLevelChangeEntry` | 不产生消息，改后续 LLM 参数 |
| ③ 纯元数据（3） | `LabelEntry` / `SessionInfoEntry` / `CustomEntry` | 既不产生消息也不改参数，只给 UI/扩展 |

理由：`buildSessionContext()` 需按类型分派——是消息就 push、是状态变更就改变量、是元数据就跳过。

`buildSessionContext` 从 leaf 往 root 遍历路径 → 按类型分派 → 状态变量**覆盖式提取**（`model` 初值 `null`，若路径上无 `model_change` 节点则由调用方兜底；**assistant 消息本身不携带"用哪个模型生成"的信息**）。

**延迟写入避免"有问无答"**（§六）：首次 assistant 消息到达前不写盘。四种情况的状态机：

| 已有 assistant？ | 已 flushed？ | 行为 |
|---|---|---|
| 没有 | 已 flushed | 立即 append |
| 没有 | 未 flushed | 标记未 flushed，**不写盘**，等 assistant |
| 有 | 未 flushed | **重写整个文件**（`openSync("wx")+writeFileSync` 保原子性），标记已 flushed |
| 有 | 已 flushed | 立即 append |

理由：避免用户问了一句但 Agent 没回（网络断）时，下次打开看到一条孤零零的用户消息。

> **对 Papertable**：本地优先应用完全适用。三组 Entry 分类法尤其值得抄——Papertable 会有"工具预算已耗尽"这类**纯元数据/仅 UI** 的条目，需要一开始就区分清楚。

### 8.3 仓库可靠性评估（重要）

**有源码行号背书、可信度较高的部分**：三层架构与注册表行号、`StreamFunction` 签名、12 种 AssistantMessageEvent、10 种 AgentEvent、17 种 AgentSessionEvent、`processEvents` 三步、`tool_execution_update` 批量收集、监听器无 try-except、两阶段管道、`excludeFromContext`、三处 cache 打点行号、`clampThinkingLevel`、`isContextOverflow`、五步管道各步行号、`createErrorToolResult` 三行、截断常量 `truncate.ts:11-13`、`resource-loader.ts:85-123`、`skills.ts:335-361`、`estimateTokens` `compaction.ts:256-296`、`findCutPoint` L392-454。

**作者主动标注的版本/实现不一致（严谨处，值得表扬）**：
- `replaceUnpairedSurrogates` **只存在于 `agent` 包**的 `truncate.ts:82`；`coding-agent` 包简化成 `Buffer.byteLength + slice` 且未保留该函数。
- `branch-summarization.ts` 在两个包各有一份，`coding-agent` 那份 371 行更详细；正文引用的是 `agent` 包行号。
- 7 个内置工具未声明 `executionMode`，实际靠 `withFileMutationQueue` 兜底。
- coding-agent 的 `SessionManager` **并未实现** agent-core 的 `SessionStorage` 接口——两套独立实现。作者称之为"接口存在但不强制复用"的松耦合真实案例。

**原文自相矛盾 / 数字对不上（采纳前必须核实）**：
- `terminate` 语义：第 3 章 L290 注释"任何一个 terminate 则停止" vs L332 表格"全部 terminate，是 every 不是 some"。
- ThinkingLevel 说"五级"但列了六个值。
- 第 4 章说"10 种 API 翻译器"，注册表示例列 4 个 + "还有 5 个"（4+5=9≠10）。
- 第 9 章路径写 `coding-agent/src/core/compaction/compaction.ts`，第 8 章把 compaction 归到 `packages/agent/src/harness/`——两章口径不一致。
- 默认值 `reserveTokens=16384` / `keepRecentTokens=20000` / `contextWindow=200000` **没有给行号**，与其它论断的行号密度不一致。

**纯作者观点（无证据，当启发不当规范）**：
- "宁可多等，不可出错"——一票否决的动机是作者归因，非源码注释。
- 第 9 章 §五"为什么允许 assistant 切点"整节是作者构造的**反事实论证**，源码未给理由。
- **"为什么自定义消息都变成 user 角色"的角色交替论证**——原文称"LLM API 对角色顺序有严格要求……不能连续出现两个 assistant"。**这条断言不严谨**：Anthropic 实际允许合并同角色块，OpenAI 也不禁止连续 assistant。
- 中文 `chars/4` 低估量级（1 汉字 1–2 token）是估算，无实测。
- "缓存能省约 90% 输入成本"——行业常识，非 Pi 源码。
- 第 8 章 §八三条"设计精华"、"Claude Code 的 Skills、Cursor 的 docs、Cline 的 context files 本质上都是同一套机制"、"Pi 的实现是最干净的"——纯主观评价。
- "XML 边界明确、主流 LLM 对 XML 理解到位"——被广泛接受但本文未给证据。
- 第 1 章引用的"Pi 在 TerminalBench 排名第二（Claude Opus 4.5）"——**转述 Pi 官方宣传**，未独立验证。

---

## 9. 专项回答：Papertable 的四个核心问题

这一节直接回答调研任务的第 3 项。**先说总体结论：这四个问题，本仓库基本都没有答案。** 下面逐项给出"仓库有什么"和"必须自己补什么"。

### 9.1 如何检测/处理"模型一直返回 tool_calls"

**仓库有什么**：几乎没有。全 docs 目录 grep `maxTurns` / `最大轮` / `死循环` / `无限循环` / `强制最终` / `tool_choice` / `重复调用` —— **零命中**。

更糟的是，仓库里那份**唯一可执行的示例代码正好演示了这个 bug**。`pi-agent/notebooks/agent-loop.ipynb` 的 `SimpleAgent.chat()`：

```python
while True:                      # ← 无任何迭代上限
    response = self.client.chat.completions.create(
        model=self.model, messages=self.conversation,
        tools=TOOLS, tool_choice="auto",
    )
    msg = response.choices[0].message
    if not msg.tool_calls:       # ← 唯一出口
        ...
        return msg.content
    # 执行工具，结果 append，继续循环
```

**唯一出口是"模型自愿不发 tool_calls"**——这正是 Papertable 现在失效的那个假设。这段代码可以作为"反面教材"引用。

**仓库提供的两个可用挂载点**：
1. `shouldStopAfterTurn()` 钩子（第 3 章 §4.7）——每个 `turn_end` 后被调用，返回 true 则 `emit(agent_end)` + `return`。作者提到它的用途包括"达到最大 Turn 数限制"，但**没有给任何实现**。
2. 工具返回 `{terminate: true}`（第 5 章 §二 第 5 步）——注意是 `every` 语义（存疑，见 §8.3），一批工具**全部** terminate 才停。

**必须自己补**：
- 三个独立计数器：**Turn 数**、**累计工具调用数**、**累计 tool_result 字节数**。第 2.2 节的 Turn 定义说明只数其中一个是不够的。
- **不要靠 `stopReason`**——第 3 章 L293 已经明确"实际驱动循环的是 `toolCalls.length > 0`"。判断点应该放在 toolCall 数组上。

### 9.2 无进展检测（no-progress detection）

**仓库有什么**：**完全没有。** 没有重复参数指纹、没有重复工具检测、没有"零新信息"判断。这是本次调研最明确的空白。

**唯一遥远的类比**：第 9 章的 Compaction summary 模板里有个 `Progress → Blocked` 子项，专门记录"卡住的事"，让 LLM 新一轮优先解锁。这是**用 prompt 传递进展状态**，不是**用代码检测无进展**。

**必须自己补**（Papertable 的两个工具让这件事其实很容易）：
- `search_notes`：对 `normalize(query)` 做指纹。同一指纹重复出现 → 无进展。
- `read_notes`：维护"已读 note id 集合"。若某轮 `read_notes` 请求的 id **全部已在集合中** → 该轮零新信息。
- 复合信号：**连续 N 轮（建议 N=2）没有任何新 note id 进入上下文** → 判定无进展 → 触发强制收尾。
- 这比通用 agent 容易得多，因为只读库 + 两个工具意味着"进展"有精确定义：**上下文里新增的笔记内容**。

### 9.3 强制产出最终答案

**仓库有什么**：没有直接机制，但**有一个非常贴近的现成原型**——第 9 章的摘要调用（§5.4）。它是：

- 一次**独立的 LLM 调用**；
- **不带任何工具**（所以物理上不可能再发 tool_calls）；
- **固定 section 模板**（对抗 LLM 跑题）；
- **`maxTokens` 硬上限**（Compaction 用 `min(0.8×reserve, model.maxTokens)`，Branch Summary 写死 2048）。

**建议的 Papertable 实现**（直接套这个形状）：

```
预算耗尽 / 检测到无进展
  → 不再把 tools 传给模型（tools=[] 或 tool_choice="none"）
  → 追加一条消息：「检索预算已用尽。基于已读的 N 篇笔记直接回答用户问题；
                    若信息不足，明确说明缺什么、建议用户如何缩小范围。」
  → maxTokens 封顶
  → 这次调用的输出即最终答案
```

**关键工程约束（仓库没讲，必须自己处理）**：
- 掐断**必须在 Turn 边界**。第 6.4 节指出，Pi 笔记完全没有 tool_use↔tool_result 配对校验的内容；如果在一批 tool_calls 中途掐断，就会产生**孤儿 tool_use**，provider 大概率报 400。
- 若不得不中途停，**必须为每个未执行的 tool_call 补一条合成 tool_result**（内容如"因预算限制未执行"）。
- 第 9 章的"toolResult 不能作为压缩切点"是同一个约束的另一个表现——可以作为佐证。

### 9.4 两阶段（plan/act 或 search/synthesize）模式

**仓库有什么**：**没有框架级的阶段编排。** 而且第 1 章明确记录了 Pi **刻意不做计划模式**：

> | Pi 不做的 | 为什么不做 | 替代方案 |
> |---|---|---|
> | **计划模式** | 计划写到 markdown 文件里更持久、可复用 | 写 plan.md 文件 |
> | 子 Agent | 增加复杂度，降低可观察性 | tmux 多实例 |
> | MCP 支持 | MCP 服务器会在会话开始灌入 13,700+ token 的工具描述 | 带 README 的 CLI 工具，按需读 |
> | 内置待办 | TODO.md 文件更灵活 | markdown 文件 |

（`第1章-开篇-Pi-Agent框架总览.md` §4.3《Pi 的"减法哲学"》）

**最接近的东西是"拉模式懒加载"**（§4.4）：清单进 prompt、全文按需 read。但作者本人的框定很清楚——**驱动方是模型自己，框架不做阶段切换**。它是"两阶段的雏形"，不是强制编排。

**唯一真正的"不带工具的独立阶段"**是 Compaction 摘要调用（§5.4）——但它的定位是上下文管理，不是任务编排。

**对 Papertable 的判断**：Pi 的"不做计划模式"是**针对编程 agent 的合理取舍**，不应照搬。理由见 §2.1：Papertable 的流程形状（检索 → 阅读 → 综合）是**已知的**，而 Pi 面对的编程任务形状是未知的。**形状已知就该用代码控制阶段**——这是作者自己在第 3 章 §一给的判据，只是他没把它应用到这个场景。

### 9.5 UI 进度展示

**仓库有什么**：这是**唯一一个答案比较完整**的问题（§7）。可直接采纳：
- 10 种事件、4 层嵌套（Agent / Turn / Message / Tool）；
- `tool_execution_start/update/end` → 渲染"🔧 正在搜索 …" / "正在读取笔记 X"；
- 每个事件携带 `partial` **完整快照** → UI 无脑重渲染，不拼增量；
- 三种 delta 归一成单一 `message_update`，细节走 `assistantMessageEvent` 透传字段；
- 同步屏障保证 UI 不会看到乱序（`message_update` 早于 `message_start` 处理完）；
- `tool_execution_update` 是**唯一**批量等待的例外（高频低价值可合并）+ `acceptingUpdates` 闸门防孤儿回调；
- SSE 转发 Web 前端的模板（§五 场景 4）。

**必须自己补**：这些事件展示的是**单个工具的内部进度**，**不是"整体任务还差多远"**。Papertable 需要额外增加 harness 级事件，例如 `budget_update{turnsUsed, turnsMax, toolCallsUsed, notesRead}`，以及 `forced_synthesis_start`（对应 Pi 的 `compaction_start`，让 UI 能显示"检索预算用尽，正在整理答案…"）。

### 9.6 用户提供文档的上下文生命周期

**仓库有什么**：**几乎没有。** 全文 grep `附件` / `attachment` / `粘贴` / `上传` / `用户提供` 基本零命中（唯一两处：第 2 章引用 agent-core 的一句英文描述提到 "attachment support"；第 6 章一句"用户上传的附件元信息"作为自定义消息的动机举例之一，未展开）。

**能间接推出的两条**：
1. 工具结果一旦进 `context.messages` 就是历史的一部分，**每轮全量重发**，直到被 Compaction 吃掉（第 8 章 §七 链路 [7]→[9]）。
2. 系统提示词**每轮重新组装**（第 8 章 §二表格"每轮 prompt"），即 `CLAUDE.md` 内容是每轮重新读盘拼接的，不是一次性注入。

**对 Papertable 的推论**：Papertable 的笔记内容通过 `read_notes` 的 tool_result 进入上下文，因此适用第 1 条——**每轮全量重发**。这意味着读了 10 篇长笔记后，每一轮都在重发这 10 篇。**这是 Papertable 的主要 token 成本来源，也是失控循环的成本放大器**（无进展的循环不只是慢，每一轮都在重发全部已读内容）。截断（§4.2）和 Compaction（§5）都必须上。

---

## 10. 结论：该采纳什么，该警惕什么

### 10.1 建议采纳（高置信度，直接可迁移）

| # | 想法 | 出处 | 为什么适合 Papertable |
|---|---|---|---|
| 1 | **5 值 stopReason 归一化**，把 `error`/`aborted` 也注入同一枚举 | 第 3 章 §三、第 4 章 §第二层 | 让循环只有一个判断点。**但要在此基础上扩展**，见 10.2 |
| 2 | **Trace / Turn 精确定义**（Turn = 一次模型调用 + 该次触发的所有工具） | 第 3 章 §二 | 给出预算的正确计量单位；避免"数错轮"的经典 bug |
| 3 | **循环判断看 toolCalls 数组，不看 stopReason** | 第 3 章 L293 | 直接避免"`length` 截断时漏执行工具"的坑 |
| 4 | **内核 + 叠加**架构，配"剥掉任一层里层仍能跑"的试金石 | 第 3 章 §五 | Papertable 该保持内核极小，把预算/无进展检测做成显式叠加层 |
| 5 | **错误即消息**：所有工具失败编码成 `isError: true` 的 tool_result，不抛异常 | 第 5 章 §四 | 让模型能自我纠错。**必须配预算**，见 10.2 |
| 6 | **工具内部写具体错误、框架兜底只搬 `str(error)`** 的两层分工 | 第 5 章 §四 | `search_notes` 无结果时应说"0 结果，尝试更宽的词"，而非裸 error |
| 7 | **截断"摘要 + 指针"逃生通道**（`[Showing lines X-Y of Z. Full: …]`） | 第 8 章 §三 | `read_notes` 读长笔记必需。**注意它会诱发额外轮次**，须配预算 |
| 8 | **双重限制先触者胜**（行数 + 字节）+ UTF-8 边界安全 | 第 8 章 §三 | 中文笔记场景下 UTF-8 边界处理是硬需求 |
| 9 | **拉模式懒加载**：轻量清单进 prompt、全文按需 read | 第 8 章 §四 + §八.3 | Papertable 的核心范式。可进一步把**笔记目录/标签清单**放进 prompt，让模型常常能跳过 `search_notes` |
| 10 | **强制收尾 = 一次不带工具、固定模板、maxTokens 封顶的独立 LLM 调用** | 第 9 章 §四（Compaction 摘要调用） | **本仓库对 Papertable 最有价值的单一可迁移实现** |
| 11 | **固定 section 模板**对抗"LLM 被有趣细节吸引而忘记核心需求" | 第 9 章 §四、§八 | 强制收尾的 prompt 应用固定结构，不写"请回答" |
| 12 | **消息双层 + `excludeFromContext` 三级可见性** | 第 6 章 §四、§七 | 让"预算耗尽"这类元信息能只给 UI 或只给模型 |
| 13 | **10 事件 4 层嵌套 + `partial` 完整快照 + 同步屏障** | 第 7 章 §二、§三 | UI 进度展示的完整答案，直接抄 |
| 14 | **进度类事件批量等 + `acceptingUpdates` 闸门** | 第 7 章 §三 | 避免"工具已结束却还在更新"的 UI 错乱 |
| 15 | **Entry 按"对 LLM 调用的影响"分三组**（进上下文 / 改参数 / 纯元数据） | 第 10 章 §三 | 本地优先持久化的干净分类法 |
| 16 | **延迟写入避免"有问无答"** | 第 10 章 §六 | 本地笔记应用完全适用 |
| 17 | **rolling prompt cache**（打在最后一条 user message 上） | 第 3 章 §4.4 | 只读库 ⇒ `system + tools` 是极稳定前缀，收益结构性地好 |
| 18 | **`isContextOverflow()` 三重检测**（含"输出为零 + length 停止"） | 第 4 章 | "输出为零 + length"这个信号很隐蔽，值得抄 |
| 19 | **"去掉该事件后内核还能跑吗"** 作为分层判据 | 第 7 章 §七 | 简单好用的架构纪律 |

### 10.2 必须自己设计（仓库空白）

按优先级排序：

1. **轮数 / 工具调用数 / 字节数三重预算** —— 仓库零内容。挂在 `shouldStopAfterTurn` 等价物上。
2. **无进展检测** —— 仓库零内容。Papertable 有精确定义：query 指纹重复、`read_notes` 请求的 id 全部已读、连续 N 轮无新 note id。
3. **强制收尾的触发逻辑** —— 摘要调用的**形状**可抄（10.1 #10），但**何时触发**要自己定。
4. **tool_use ↔ tool_result 配对不变量** —— 仓库明确空白（§6.4），且这是 Papertable 最容易出 400 的地方。**规则：只在 Turn 边界掐断，或为未执行的 tool_call 补合成 tool_result。**
5. **重试 / 退避 / HTTP 状态码分类（429、5xx）/ 超时** —— 第 4 章空白，`auto_retry` 被推到产品层且零描述。
6. **harness 级进度事件**（`budget_update`、`forced_synthesis_start`） —— Pi 的事件只覆盖单工具进度，不覆盖"整体还差多远"。
7. **中文 token 估算** —— 作者自己承认 `chars/4` 对中文严重低估。本地笔记大量中文场景必须换真 tokenizer 或改系数。

### 10.3 应当警惕的观点（作者的意见，不是事实）

| 观点 | 为什么要警惕 |
|---|---|
| **"不需要任何'任务完成度'判断逻辑，代码只做最简单的那层判断"**（第 3 章 L319） | **这正是 Papertable 的 bug 本身。** 作者把"只看有没有 toolCall"称为"既是局限，也是优雅"——对编程 agent（人类在旁边看着、随时能 Ctrl-C）成立；对 Papertable（可能无人值守、成本直接烧在重发已读笔记上）不成立。 |
| **"shouldStopAfterTurn 是产品层的安全阀，最简 Loop 不需要它"**（第 3 章 L1080） | 对 Papertable **是错的**。轮数上限不是"产品功能"，是**正确性要求**。它应该在内核里，不是叠加层。 |
| **Pi 刻意不做"计划模式"**（第 1 章 §4.3） | 这是针对**任务形状未知**的编程 agent 的取舍。Papertable 的流程形状（检索→阅读→综合）**已知**，按作者自己在第 3 章 §一给的判据，形状已知就该用代码控制阶段。**不要照搬这个取舍。** |
| **"错误即消息，让模型自己换路径重试"**（第 5 章 §四） | 方向正确，但作者**从未讨论其反面**：在没有预算和无进展检测时，这套设计会**直接放大**无限重试。采纳时必须同时上预算。 |
| **"截断后给指针让模型自己去 read"**（第 8 章 §三） | 好设计，但它**本质上是在鼓励模型多发一轮工具调用**——与 Papertable 的失控问题直接冲突。指针必须配预算，且预算耗尽时应停止提供指针。 |
| **"LLM API 对角色顺序有严格要求，不能连续两个 assistant"**（第 6 章 §六） | **技术上不准确**。Anthropic 允许合并同角色块，OpenAI 也不禁止连续 assistant。别把它当协议规范去设计数据结构。 |
| **"一票否决保守策略：宁可多等，不可出错"**（第 5 章 §三） | 是作者的**归因**，非源码注释。而且作者自己指出 7 个内置工具都没声明 `executionMode`——该机制实际处于休眠。Papertable 两个只读工具无需这套复杂度。 |
| **`chars/4` token 估算** | 作者自己承认对中文严重低估。中文笔记场景**必须**替换。 |
| **"Pi 在 TerminalBench 排名第二"**（第 1 章 §4.1） | 转述 Pi 官方宣传，未独立验证。不应作为"照抄 Pi 的设计就好"的论据。 |
| **各种"最干净的实现"/"设计精华"评价** | 纯主观。本仓库是一个人的学习笔记，非同行评议材料。 |
| **所有 `文件:行号`** | 引用的是 Pi **v0.80.2**。作者本人标注了至少 4 处包间实现不一致、多处数字自相矛盾（§8.3）。采纳前回 `earendil-works/pi` 核实。 |

### 10.4 一句话总括

**dg-ai-notes 是一份关于"Agent Loop 怎么转"的优秀笔记，但它对"Agent Loop 怎么停"几乎没有内容。** Papertable 可以从它拿走整套架构骨架——终止状态分类学、事件模型、上下文分层防护、消息双层设计、以及一个现成的"不带工具的强制综合调用"原型——但**必须自己发明预算、无进展检测和收尾触发逻辑，并主动抵制作者"代码不该判断任务完成度"这个核心主张**，因为那正是 Papertable 要解决的问题。

---

## 附录 A：文件索引（按对 Papertable 的价值排序）

| 优先级 | 文件 | 为什么读 |
|---|---|---|
| ★★★ | `pi-agent/docs/python/第3章-Agent-Loop-让模型转动起来的引擎.md` | 终止分类学、Trace/Turn、stopReason、四条退出路径、内核+叠加、流式原地替换、prompt cache |
| ★★★ | `pi-agent/docs/python/第8章-上下文工程-让有限窗口装下无限对话.md` | 截断 + 逃生通道、拉模式懒加载、系统提示词 9 段骨架 |
| ★★★ | `pi-agent/docs/python/第9章-上下文压缩-当对话太长怎么办.md` | **强制收尾原型**（不带工具的独立调用 + 固定模板 + maxTokens 封顶）、切点选择 |
| ★★ | `pi-agent/docs/python/第7章-事件驱动-Agent的神经系统.md` | 10 事件 4 层嵌套、同步屏障、UI 进度模板 |
| ★★ | `pi-agent/docs/python/第5章-工具系统-Agent的手脚是怎么被管住的.md` | 五步管道、错误防线、`terminate` 原语、并行三阶段 |
| ★★ | `pi-agent/docs/python/第6章-消息系统-Agent的记忆如何组织与传递.md` | 双层消息、两阶段管道、`excludeFromContext` |
| ★ | `pi-agent/docs/python/第4章-模型调用-一行代码驾驭多个模型.md` | Provider 抽象（函数签名而非基类）、stopReason 跨家归一、`isContextOverflow` |
| ★ | `pi-agent/docs/python/第10章-会话管理-对话的存储恢复与分叉.md` | 9 种 Entry 三组分类、append-only 认父不认子、延迟写入 |
| ★ | `pi-agent/docs/python/第1章-开篇-Pi-Agent框架总览.md` | §4.3 减法哲学表（Pi 刻意不做什么及理由） |
| ○ | `pi-agent/notebooks/agent-loop.ipynb` | **反面教材**：`while True` 无上限循环，唯一出口是模型自愿不发 tool_calls |
| ○ | `pi-agent/docs/typescript/第*.md` | 与 python 版同内容，TS 语法。核实源码引用时用这版 |
| ○ | `pi-agent/docs/python/_chapter-design/第11章-扩展系统-设计文档.md` | 未发布章节的设计稿；扩展系统两阶段绑定、API 门面三层最小权限 |
| — | `pi-agent/web/` | Astro 阅读网站，与 harness 无关 |

## 附录 B：调研方法与覆盖度

- 仓库为 shallow sparse worktree，初始仅 checkout 3 个文件；通过 `git sparse-checkout set --skip-checks` 展开 `pi-agent/docs/python`、`pi-agent/README.md`、`pi-agent/notebooks` 后完成阅读。TS 版与 assets 未展开（内容与 python 版重复）。
- 第 3、10 章及第 1 章 §4.3、第 8 章 §四/§八由主 agent 全文精读；第 4、5、6、7、8、9 章由两个并行子 agent 全文精读后交叉汇总。
- 对 `maxTurn` / `最大轮` / `死循环` / `无限循环` / `空转` / `预算` / `budget` / `超时` / `timeout` / `强制` / `两阶段` / `plan` / `重复调用` / `进度` / `toolChoice` / `tool_choice` / `只读` / `能力` / `附件` / `检索` 等 20+ 关键词做了全 docs 目录 grep，用于确认空白项。
- **未修改仓库任何文件。**
- `pi-agent/notebooks/agent-loop.ipynb` 中的 `API_KEY` 经检查为 32 位占位符（无数字、无真实密钥特征），**无凭据泄露**。
