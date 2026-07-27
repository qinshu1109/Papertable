# 纸桌 Papertable

一个本地优先的图结构知识探索网页：中央卡片堆叠负责阅读当前路径，右侧关系图负责浏览整个项目；深挖、发散、改道不是视觉方向，而是三种明确的上下文继承规则。

## 启动

需要 Node.js 24 和 pnpm 11。

```bash
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:5173>，进入「设置」即可填写接口地址、模型和轮换后的 API 密钥。密钥只会提交给只监听 `127.0.0.1:8787` 的本机服务，保存到未提交的 `.env.local`；浏览器不会收到或保存它。

也可以在启动前手动创建配置：

```bash
cp .env.example .env.local
# 编辑 .env.local，填写轮换后的 COZAI_API_KEY
```

桌面版（Tauri + SQLite + Obsidian 知识库同步）见 [docs/DESKTOP.md](docs/DESKTOP.md)：

```bash
pnpm desktop          # 开发
pnpm desktop:signed   # 构建并 ad-hoc 签名，自用
```

常用检查：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
pnpm test:rust  # 桌面版的持久化与知识库同步语义
pnpm start # 构建后在 http://127.0.0.1:8787 提供网页与本机 API
```

## 已实现的完整链路

- CozAI 的 `claude-opus-5`：流式回答、停止、超时、断线和可读错误提示；401、429、5xx 不会静默回退为假回答。
- 三种真实上下文：
  - **深挖**：来源主题 + 冻结的精确选区，不带父卡完整历史；
  - **发散**：只带来源主题；
  - **改道**：只带来源卡片到指定轮次为止的冻结历史。
- 每张卡片可切换下一次回答的依据：**通用探索**会优先使用项目材料、在材料不足时补充并明确标注通用知识或推断；**仅依据材料**只使用明确带入的内容，证据不足会直接说明。旧卡片默认按通用探索处理，切换不会改写历史回答。
- 输入器的「本次上下文」直接读取实际 `buildContext()` 结果，显示带入与排除的内容。
- IndexedDB 自动保存项目、卡片、轮次、边、锚点、快照、引用、草稿、阅读位置和折叠状态。生成中至少每 500 ms 保存一次；中断后保留已生成文本并标记为已停止。
- 点击文本选区可深挖、引用或复制；概念解释浮层使用真实模型流式回答，按「概念 + 来源版本」持久缓存，可升级为正式卡片。
- 回答后的短标题与概念提取在后台执行，不阻塞继续提问；不会保存或展示模型隐藏推理。所有模型文本都经过 `src/lib/modelOutput.ts` 的闸门：正文按句子逐段释放，已释放的内容不会回退，未能确认为最终回答的部分宁可继续缓冲——被停止时缓冲区直接丢弃，不会落盘。网关若把推理放在独立字段，本机服务会在进程内直接丢弃它，只转发可信正文。
- 导入：单个 Markdown、Markdown 文件夹、JSON Canvas + Markdown、无损项目包。
- 导出：Markdown 文件夹 ZIP、JSON Canvas + Markdown ZIP、无损项目包 ZIP；无损包可恢复关系、上下文快照、锚点、引用和视图状态。
- 卡片 / 关系树联动、三种关系、删除撤销、独立滚动位置、项目隔离、移动端抽屉和迷你关系导航全部保留。
- **注意力观察（第一阶段）**：本机记录收藏、实际发送的引用、建分支、概念升级、标题/问题编辑、跨会话重访、概念预览与 120 秒有效停留；次日只用确定性规则生成 0–3 条“幽灵分支”，不额外调用模型。点击幽灵节点或“查看”只打开详情和可编辑问题，**不会**建卡、建边或调用模型；只有明确点击“开始探索”才物化为正式卡片并生成回答。
- 提案 72 小时后进入冷却、7 天后清理低信号项；设置页可暂停观察并查看每日信号、提示次数、展开率与二次强信号。第一阶段提供 `NoopProvider` 接口占位，**没有连接 MemOS**。

## 安全与本地数据

- `.env.local` 已被 Git 忽略；可由设置页维护。不要把密钥放入代码、浏览器控制台、截图、导出包或提交记录。
- 贴到聊天中的旧密钥应视为已泄露，请先在 CozAI 轮换，再通过设置页或 `.env.local` 填写新的密钥。
- 默认数据仅保存在当前浏览器的 IndexedDB；设置页可导出全部备份或经二次确认清除。
- 对话请求不接受浏览器传入的目标地址；只有设置页可通过本机端点保存 HTTPS（或本机 HTTP）接口地址和模型名，不能被当作开放代理使用。

## 项目结构

```text
server/
  index.mjs             # 127.0.0.1 本机 API：健康检查 / 本机设置 / 流式 / 后台生成
  cozai.mjs             # OpenAI SSE → Papertable token/done/error 适配；草稿丢弃、正文标记
src/
  lib/context.ts        # 与 React、Dexie、模型 SDK 无关的 buildContext()
  lib/modelOutput.ts    # 默认扣留的输出闸门：隐藏推理不展示、更不落盘
  lib/attention.ts      # 会话边界、行为聚合、幽灵分支评分与生命周期（纯本地）
  lib/memory.ts         # MemoryProvider / NoopProvider 占位，不连接 MemOS
  lib/provider.ts       # 浏览器到本机 API 的客户端
  lib/delta.ts          # 与存储后端无关的增量计算；删除永不由内存基线推导
  lib/storage/          # 适配器接缝：dexie（web）/ tauri（桌面）；store 换后端零改动
  lib/vaultNote.ts      # 知识库笔记序列化（纯内容，不碰磁盘）
  lib/vaultPlan.ts      # 「这次要写哪些文件」（纯函数）
  lib/wikilink.ts       # [[双链]] 解析：只生成引用，绝不推断继承边
src-tauri/src/
  db.rs                 # SQLite；语义与 dexie 逐条对齐，外键顺序父→子
  vault.rs              # 容纳规则、归一化哈希、冲突隔离
  watcher.rs            # 三层环路防护；入向只新增 ReferenceChip
  llm.rs                # 桌面模型通道；草稿推理在进程内丢弃
  lib/formats.ts        # Markdown / JSON Canvas / 无损包格式适配器
  store.tsx             # 业务编排；组件只使用其公开动作
  components/           # 卡片堆叠、关系树、输入器、概念预览、对话框
```

## 格式约定

无损项目包是唯一要求完整往返的格式：

```text
项目名/
├── manifest.json
├── graph.json
├── cards/*.md
└── assets/
```

Markdown 和 JSON Canvas 是开放互操作格式；普通 Markdown 双链会被导入为 `reference`，不会被擅自解释为上下文继承边——边携带冻结的上下文快照，而一条 `[[链接]]` 没有快照，由它推断边等于凭空伪造出处。网页环境会将目录导出为 ZIP 下载。**桌面版**可以选定一个 Obsidian 知识库，按项目开启单向同步，并监听目录把 `[[双链]]` 解析成引用；回流 Obsidian 的编辑到卡片正文仍然不做。

## 测试覆盖

`pnpm test` 覆盖：两种回答依据的精确系统指令、三种关系上下文、引用排序与去重、问题编辑改道、项目隔离、IndexedDB v3 保存恢复、行为信号聚合、提案上限与冷却、无损包往返，以及上游 SSE 到统一事件的转换和错误映射。`pnpm test:e2e` 显式启动本机假模型，跑桌面流式卡片、停止后恢复、390px 无横向溢出，以及“跨日信号 → 只查看幽灵分支 → 编辑问题 → 明确物化”流程；真实 CozAI 请求不在默认测试中执行，避免消耗额度。

视觉规范见 [DESIGN_NOTES.md](DESIGN_NOTES.md)，架构边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，安全说明见 [SECURITY.md](SECURITY.md)。
