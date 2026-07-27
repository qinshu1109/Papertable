# Papertable 架构

## 运行边界

```text
React 网页 / Tauri 桌面壳
  ├── Workspace StorageAdapter（项目、卡片、关系与视图）
  ├── NoteLibraryAdapter（只读资料库、文档与切块索引）
  └── Provider
       ├── Web：/api/* → 127.0.0.1 本机 Node 服务
       └── Desktop：Rust → CozAI /v1/chat/completions
```

网页保持现有交互；Node 服务负责密钥保护、流式协议适配和本机模型设置，不保存用户项目数据。普通对话请求不能指定目标地址；设置页仅可经本机端点保存 HTTPS（或本机 HTTP）接口地址、模型和密钥。网页不会存储或回显 API key。桌面端不经过 Node，而是由 Rust 实现同一份 provider 协议；两条通道都只转发最终正文，进程内直接丢弃隐藏推理。

## 领域内核

`src/lib/context.ts` 是纯函数，不依赖 React、Dexie 或模型 SDK：

```ts
buildContext({ cards, edges, snapshots, references, currentCardId });
// => { answerMode, system, messages, provenance, excluded, estimatedTokens }
```

`CardEdge` 是关系真相，`ContextSnapshot` 在创建边时冻结来源含义。布局方向只影响动画和关系图，不影响模型上下文。

| 关系 | 实际携带                               | 明确排除           |
| ---- | -------------------------------------- | ------------------ |
| 根卡 | 当前卡片轮次、显式引用                 | 其他项目和其他分支 |
| 深挖 | 来源标题、精确选区快照、当前子卡轮次   | 父卡完整历史       |
| 发散 | 来源标题、当前卡片轮次                 | 来源卡对话         |
| 改道 | 来源卡到分支点的冻结历史、当前分支轮次 | 分支点之后内容     |

显式引用按用户添加顺序进入上下文，按来源锚点去重。`Composer` 不自行猜上下文，只渲染 `BuiltContext.provenance` 和 `excluded`。

每张 `Card` 可选的 `answerMode` 是请求层边界：旧数据缺省时按 `general`。`general` 优先使用同一套关系、快照与显式引用，在材料不足时允许补充通用知识，但必须区分材料、通用知识与推断；`sources-only` 使用完全相同的 provenance、excluded、关系和引用顺序，只把系统指令收紧为“只依据明确上下文”。切换只影响下一次请求，不改写旧回答。

## 持久化

`src/lib/storage.ts` 使用 Dexie 管理一个版本化 IndexedDB schema：

- `projects`、`cards`、`turns`、`edges`
- `anchors`、`snapshots`、`references`
- `view`、`settings`
- `interactionEvents`（append-only 行为事件）、`sessionBoundaries`、`proposals`
- `noteLibraries`、`noteDocuments`、`noteChunks`、`projectNoteLibraries`（独立的只读资料索引与项目绑定）

卡片与轮次分表。日常保存走 `applyChanges()` 的增量写入：与上次落库的快照做引用比较，只写真正变了的行。模型 token 先进入每个任务自己的输出闸门与 UI 节流器：当前可见卡片最多约每 80 ms 提交一次，后台卡片最多约每 360 ms 提交一次；每次只触碰一张卡片和一条轮次。持久化仍按最多 500 ms 批量保存；停止会先刷出已经通过闸门的正文，再标记为已停止。

增量计算本身在 `src/lib/delta.ts`，是与存储后端无关的纯函数。未来迁移到 Tauri/SQLite 时，组件、`buildContext()` 和 `delta.ts` 都无需修改，只替换 `storage.ts`（`StorageAdapter` 就是它需要实现的全部表面）。

### 删除规则（不变量）

**一行只能通过 (1) 指名具体 id 的显式意图，或 (2) 在写事务内针对数据库求值的谓词来删除；永不通过与内存基线做集合差。**

自动保存的工作区写入口不具备删除能力——`WorkspaceUpsert` 里根本没有 `deletes` 字段。删除只有三个入口：

- `deleteProjectCascade(projectId)`：在事务内按 projectId 重新查库定位所有从属行，因此另一个标签页刚建的卡片也会被正确删除；返回被删的行供撤销精确还原。
- `deleteReferences(ids)` / `deleteProposals(ids)`：调用点永远拿得到具体 id。

这条规则的由来：删除原本是从「每个标签页私有、挂载后再不与库对账的基线」推导出来的，于是一个陈旧的标签页会真正 `bulkDelete` 掉另一个标签页刚建的行——不是覆盖，是删除。规则与存储后端无关，SQLite 迁移后继续成立（届时级联会塌缩成一句带 `ON DELETE CASCADE` 的 `DELETE`）。

残留的最坏情况是「复活已删行」：另一个标签页删了某行，本标签页的基线还留着它，于是又写回去。那是可见的、非破坏性的。真正的跨标签页实时同步（BroadcastChannel 增量广播）尚未实现。

`putAttentionState()` 是 upsert-only，绝不会清掉 append-only 的行为事件，也不会清掉另一个标签页生成的会话与提案。“清除本地数据”是唯一的全量清除。

## 只读笔记 Harness Alpha

资料检索不是 `StorageAdapter` 的附属功能。它通过独立的 `NoteLibraryAdapter` 读写自己的索引表，工作区和资料库只用 `projectId → libraryId[]` 的显式绑定相连：

```text
Markdown / 已连接 Vault
  → NoteLibrary / NoteDocument / NoteChunk
  → 项目绑定的只读范围
  → search_notes / read_notes
  → Agent Loop
  → 受控引用与可点击临时来源卡
```

- Web 端把导入文件切为标题层级块；超过约 800 字继续按段落切分并保留约 80 字重叠，MiniSearch 在 Web Worker 中建立中文友好的索引，避免阻塞 React。
- 桌面端把已连接 Vault 作为资料源，在 SQLite 中保存可重建的文档/块索引，并用 FTS5 检索；隐藏目录、`.obsidian`、`.trash` 与 Papertable 的输出子树都不进入语料。外部笔记不会自动创建 Card，也不会被写回。
- 每个请求开始时，宿主冻结当前项目绑定的资料库。模型没有路径、Vault、scope 或任意文件读取参数；未绑定资料库的项目没有可检索范围。
- `search_notes(query, limit?)` 只接受短查询，`limit` 被钳制到 1–8；`read_notes(chunkIds)` 最多读 4 块，且只能读同一轮搜索实际返回过的 chunk id。所有调用统一经过 normalize → validate → gate → execute → post-process，异常作为结构化工具结果回给模型。
- 笔记内容被视为不可信资料。资料中的提示词、命令、路径或“改写规则”要求不能改变系统指令或扩大工具范围。

`src/lib/agent.ts` 是有界编排层，而不是常驻 Agent：最多 4 个工具轮次、8 次工具调用、120 秒墙钟；同一工具同一参数连续失败两次后拒绝重试。用户停止会取消模型及未执行工具，已经通过正文闸门的文本仍按既有行为保留。

### 原生工具与双阶段回退

模型能力不是静态仓库配置。应用按 `baseUrl + model` 探测并本地缓存：是否接受 `tools` / `tool_choice`、是否能流式拆出 `tool_calls`、是否接受 `tool` role 回填。地址或模型改变时缓存自然失效。

```text
能力完整 → native-tools
  模型 tool_calls → 宿主执行只读工具 → tool role 回填 → 最终回答

能力未知 / 探测失败 → two-stage
  短调用产出检索词 JSON → 本地搜索并读取 → 第二次调用依据资料回答
```

两种模式的输出都走同一个 `ProviderStreamEvent`。双阶段的检索词 JSON 最多重试一次：仍不合法或没有命中时，`general` 会明确标出本轮资料检索不可用后才可使用通用知识；`sources-only` 必须直接说明证据不足，不能退回通用知识。

### 引用与运行轨迹

只有本轮 `read_notes` 实际读取过的 `chunkId` 才能成为引用。模型可在最终正文中写 `[[source:chunkId]]`，渲染前由宿主剥离标记并验证：猜测的或未读的 id 会被丢弃，不会形成链接。`Turn.citations` 保存标题、相对路径、文档哈希与冻结摘录；点击引用打开临时来源卡，绝不创建主会话轮次或自动 ReferenceChip。若源笔记以后变更，界面显示“来源已更新”，仍能查看当时的冻结摘录。

`Turn.agentRun` 是可审计的运行摘要：执行模式、搜索词、命中数、读取块、截断、错误与耗时。它不保存思维链、规划草稿或任何隐藏推理。“本次上下文”只读取真实 trace，不重新猜一套检索过程。

## 注意力提案侧车（第一阶段）

```text
用户有效行为
  → InteractionEvent（本机 append-only）
  → 项目内 SessionBoundary
  → 次日首次打开时的确定性聚合
  → Proposal（幽灵分支，不是 Card）
  → 用户查看并编辑问题（不产生模型请求）
  → 明确开始后才创建 Card + CardEdge + ContextSnapshot + 主回答
```

`src/lib/attention.ts` 是纯函数：它只处理本地时间、事件、卡片和锚点，不调用模型，也不依赖 React、Dexie 或网络。行为候选需要一条强信号或两条中信号；每项目最多五条未处理提案，每次最多展示三条、其中最多一条复用既有概念结果的 `ai-wildcard`。72 小时未处理进入 `cooled`，七天后低信号项移除；一条高信号冷却记录最多保留在本机短期审计中。

Proposal 不进入 `buildContext()`、正式卡片搜索或任何标准 Markdown / JSON Canvas / 项目包导出。`previewProposal(id)` 只将 `queued` 标为 `opened` 并选择详情，绝不建立卡片、边、快照或访问模型；`materializeProposal(id, finalQuestion)` 才在防重入保护下创建一张卡、一条边和一个快照，记录 `proposalId` / `acceptedCardId`，并由正常主回答链路生成。`src/lib/memory.ts` 仅提供 `MemoryProvider` / `NoopProvider` 边界；本阶段没有接 MemOS、蒸馏或额外后台模型调用。

## 模型适配

- `server/index.mjs`：`GET /api/health`、`GET/POST /api/config`、`POST /api/llm/capabilities`、`POST /api/llm/stream`、`POST /api/llm/generate`；
- `server/cozai.mjs`：上游 OpenAI-style SSE 转统一 `token / tool-call-delta / done / error`，并保留 `tool_calls` / `tool` role 需要的结构；
- `src/lib/provider/`：Web 与 Tauri 请求、能力探测、非流式 completion 和 SSE 解析；
- `store.tsx`：主回答入口；普通聊天与资料 Harness 都按 cardId 登记，不绑定当前项目或当前卡片。切换视图不取消，删除卡片、明确停止或应用退出才取消；
- `src/lib/streamThrottle.ts`：合并高频 token，当前卡片平滑刷新、后台卡片低频刷新，结束和停止时强制提交最新正文；
- `src-tauri/src/lib.rs`：桌面端持有独立生成任务表、工具事件和取消标记，窗口失焦不会终止 Rust 侧上游连接；
- 概念、标题、概念提取为非阻塞后台任务。

失败时会保留部分输出。401、429、5xx、超时和网络错误都有中文提示，绝不退回假数据。

模型草稿（例如上游的 `reasoning_content`）不是产品数据：本机中继识别后立刻丢弃，正文
仍必须通过 `ANSWER_SENTINEL` 闸门才会展示或持久化。草稿不进入 React state、IndexedDB、
SQLite、导出包、知识库同步、后续 `buildContext()` 或任何 UI；旧版本遗留字段会在存储迁移和
每次读取前的兼容清理中移除。

## 格式适配

`src/lib/formats.ts` 维护统一格式适配器。内部 `PortableProject` 是无损传输模型；其它格式是可互操作的视图。

1. **无损项目包**：`manifest.json + graph.json + cards/*.md + assets/`，能保存完整快照、锚点、关系、`Turn.agentRun`、受控引用和视图状态；资料库正文不随单项目包复制；
2. **Markdown 文件夹**：每卡一篇 Markdown，使用稳定 ID 与 frontmatter；`answerMode` 不是普通 frontmatter 的公开字段，回答引用则写成可读的标题、相对路径与冻结摘录；
3. **JSON Canvas + Markdown**：文件节点引用同一份 Markdown，边标签记录「深挖 / 发散 / 改道」，因此同样保留人可读引用。

所有导入都先完成解析和验证，再把归一化后的图谱写入状态。普通双链只生成引用，不自动创造上下文继承关系。网页的“导出全部备份”可以包含 Web 导入资料库的原始文件以便恢复；桌面 Vault 索引只是可重建缓存，不能当作 Vault 的备份或同步机制。

## 明确不在当前版本

账号、云同步、计费、协作、远程部署、PDF/DOCX/PPTX 解析、向量检索/RAG、MCP、多分支合并、笔记双向同步；也不接 MemOS、临时胶囊、蒸馏、常驻 Agent 或自动写笔记。Harness 只提供有界、按项目绑定范围的本地只读检索，不能破坏上面的关系、快照、格式和本地优先边界。
