# Papertable 架构

## 运行边界

```text
React 网页
  ├── IndexedDB（用户项目与视图状态）
  └── /api/*
       └── 127.0.0.1 本机 Node 服务
            └── CozAI /v1/chat/completions
```

网页保持现有交互；Node 服务负责密钥保护、流式协议适配和本机模型设置，不保存用户项目数据。普通对话请求不能指定目标地址；设置页仅可经本机端点保存 HTTPS（或本机 HTTP）接口地址、模型和密钥。网页不会存储或回显 API key。

## 领域内核

`src/lib/context.ts` 是纯函数，不依赖 React、Dexie 或模型 SDK：

```ts
buildContext({ cards, edges, snapshots, references, currentCardId });
// => { system, messages, provenance, excluded, estimatedTokens }
```

`CardEdge` 是关系真相，`ContextSnapshot` 在创建边时冻结来源含义。布局方向只影响动画和关系图，不影响模型上下文。

| 关系 | 实际携带                               | 明确排除           |
| ---- | -------------------------------------- | ------------------ |
| 根卡 | 当前卡片轮次、显式引用                 | 其他项目和其他分支 |
| 深挖 | 来源标题、精确选区快照、当前子卡轮次   | 父卡完整历史       |
| 发散 | 来源标题、当前卡片轮次                 | 来源卡对话         |
| 改道 | 来源卡到分支点的冻结历史、当前分支轮次 | 分支点之后内容     |

显式引用按用户添加顺序进入上下文，按来源锚点去重。`Composer` 不自行猜上下文，只渲染 `BuiltContext.provenance` 和 `excluded`。

## 持久化

`src/lib/storage.ts` 使用 Dexie 管理一个版本化 IndexedDB schema：

- `projects`、`cards`、`turns`、`edges`
- `anchors`、`snapshots`、`references`
- `view`、`settings`
- `interactionEvents`（append-only 行为事件）、`sessionBoundaries`、`proposals`

卡片与轮次分表；写入在同一个 IndexedDB transaction 中替换一致快照。正常变化很快保存，流式生成按最多 500 ms 批量保存；停止后的部分内容保留。未来迁移到 Tauri/SQLite 时，组件和 `buildContext()` 无需修改，只替换 storage adapter。

普通 `saveWorkspace()` 明确只替换业务表，绝不会清掉 append-only 的行为事件。项目删除与“清除本地数据”才会同时删除实验表。

## 注意力提案侧车（第一阶段）

```text
用户有效行为
  → InteractionEvent（本机 append-only）
  → 项目内 SessionBoundary
  → 次日首次打开时的确定性聚合
  → Proposal（幽灵分支，不是 Card）
  → 用户点击后才创建 Card + CardEdge + ContextSnapshot
```

`src/lib/attention.ts` 是纯函数：它只处理本地时间、事件、卡片和锚点，不调用模型，也不依赖 React、Dexie 或网络。行为候选需要一条强信号或两条中信号；每项目最多五条未处理提案，每次最多展示三条、其中最多一条复用既有概念结果的 `ai-wildcard`。72 小时未处理进入 `cooled`，七天后低信号项移除；一条高信号冷却记录最多保留在本机短期审计中。

Proposal 不进入 `buildContext()`、正式卡片搜索或任何标准 Markdown / JSON Canvas / 项目包导出。`src/lib/memory.ts` 仅提供 `MemoryProvider` / `NoopProvider` 边界；本阶段没有接 MemOS、蒸馏或额外后台模型调用。

## 模型适配

- `server/index.mjs`：`GET /api/health`、`GET/POST /api/config`、`POST /api/llm/stream`、`POST /api/llm/generate`；
- `server/cozai.mjs`：上游 OpenAI-style SSE 转 `token / done / error`；
- `src/lib/provider.ts`：浏览器请求与 SSE 解析；
- `store.tsx`：唯一的普通聊天流式入口；概念、标题、概念提取为非阻塞后台任务。

失败时会保留部分输出。401、429、5xx、超时和网络错误都有中文提示，绝不退回假数据。

## 格式适配

`src/lib/formats.ts` 维护统一格式适配器。内部 `PortableProject` 是无损传输模型；其它格式是可互操作的视图。

1. **无损项目包**：`manifest.json + graph.json + cards/*.md + assets/`，能保存完整快照、锚点、关系和视图状态；
2. **Markdown 文件夹**：每卡一篇 Markdown，使用稳定 ID 与 frontmatter；
3. **JSON Canvas + Markdown**：文件节点引用 Markdown，边标签记录「深挖 / 发散 / 改道」。

所有导入都先完成解析和验证，再把归一化后的图谱写入状态。普通双链只生成引用，不自动创造上下文继承关系。

## 明确不在当前版本

账号、云同步、计费、协作、远程部署、PDF/DOCX/PPTX 解析、RAG、MCP、多分支合并、笔记目录监听和双向同步；也不接 MemOS、临时胶囊、蒸馏或自动写笔记。它们不能破坏上面的关系、快照、格式和本地优先边界。
