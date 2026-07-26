# Obsidian vault 同步 · 格式与约束

S0 阶段在真实 vault（`~/主知识库_AI`）里跑过一次 dry-run 之后的结论，S3 已按此实现：
序列化在 `src/lib/vaultNote.ts`（纯内容）、编排在 `src/lib/vaultPlan.ts`（纯函数）、
容纳与冲突在 `src-tauri/src/vault.rs`。产出这些结论的一次性脚本已删除。

## 容纳规则

Papertable 只拥有一个子树：

```
~/主知识库_AI/80_AI暂存/Papertable/<项目名>/
```

所有写路径经过唯一一个 `resolve()`，canonicalize 后断言 `starts_with(papertable_root)`，
拒绝 `..`、符号链接和绝对路径分量。**没有第二条写路径。**

晋升到 `10_活跃知识` / `20_项目` 永远由 `knowledge-coach` 的 preview → publish → verify
完成，Papertable 不碰。

落点已与用户确认：`80_AI暂存/Papertable/`，与 `80_AI暂存/技术调研` 平级。
`AGENTS.md` 里「候选与预览只能写入 `80_AI暂存/知识教练`」那条针对的是 knowledge-coach
的候选流水线；Papertable 不是那条流水线，混进去反而会污染它的语义。

## obsidian-linter 带来的硬约束

vault 的 `.obsidian/plugins/obsidian-linter/data.json` 里 `lintOnSave: true`，
启用规则含 `yaml-key-sort`（字母序）、`escape-yaml-special-characters`、
`trailing-spaces`、`consecutive-blank-lines`、`header-increment`。

- **好消息**：`lintOnFileChange: false`，我们自己的磁盘写入不会触发 Linter 重写，
  环路问题少一半。
- **坏消息**：用户每次保存，frontmatter 键都会被按字母序重排。

因此 **归一化哈希是硬需求，不是优化**。字节级哈希会在每次保存时误报冲突，哪怕用户
什么都没改。归一化步骤：

1. 拆出 frontmatter，逐行 `trimEnd`、去空行、**排序**；
2. 正文逐行 `trimEnd`，`\n{3,}` 折叠为 `\n\n`，首尾 `trim`；
3. 对 `frontmatter + "\n \n" + body` 取 sha256。

`src-tauri/src/vault.rs` 的测试守着这条：模拟 Linter 重排后**字节不同、哈希相同**，
而真正改动一句正文能被检出。真机上也验证过：手动改一篇已同步的笔记再触发同步，
文件逐字节未变，旁边生成 `.papertable-conflict.md`，`sync_state` 置为 conflict。

## 笔记格式

```markdown
---
papertable_id: c-decoherence
papertable_project: p-quantum
papertable_relation: child # root | child | divergent | branch
papertable_created: 2026-07-27T…Z
papertable_synced_at: 2026-07-27T…Z
papertable_source: "[[父卡标题]]"
papertable_hash: e0667a0e10d9457b
---

# 量子退相干

> [!quote] 来自 [[父卡标题]] 的选区
> 只有真的带了选中片段时才出现

> [!question] 深挖：量子退相干到底是什么？

（模型正文，从 ## 开始）
```

键名统一 `papertable_` 前缀：`yaml-key-sort` 重排后它们仍然连续，结果稳定可预测。

### S0 校准出来的四条（dry-run 之前都想错了）

1. **文件名不带 id 后缀。** ZIP 导出用的 `${title}-${id.slice(-8)}` 在压缩包里无所谓，
   在 vault 里这个后缀会出现在快速切换器和每一条 `[[双链]]` 上——`量子退相干-oherence`、
   `希尔伯特空间--hilbert` 这种噪音让笔记读起来像导出物而不是知识。只在**同项目内标题
   真的重名**时才补后缀。

   重命名追踪不需要它：id 在 frontmatter 里，而 macOS FSEvents 是目录粒度的，本来就
   必须按 `papertable_id` 匹配而不是按路径。

2. **单问单答的卡片不套 `## 用户` / `## 助手` 骨架。** 模型正文本身就是从 `##` 开始的，
   加一层同级标题会让 Obsidian 大纲错乱，`header-increment` 还可能去重排它们。去掉骨架
   之后，这类笔记读起来就是知识而不是聊天记录——这是让「卡片」变成「笔记」最有效的一步，
   而且零成本。多轮卡片仍然保留角色标题。

3. **来源引用块只在有真实选区时才写。** 发散边没有 `sourceText`，之前会渲染出一个内容
   只是父卡标题的 callout，纯噪音。关系本身已经在 frontmatter 和 canvas 里表达了。

4. **JSON Canvas 的 `file` 是 vault 相对路径**，不是项目相对路径。dry-run 里 8 个节点、
   0 个悬空引用，能在 Obsidian 里直接打开。

## 对象 → 文件映射

| Papertable 对象                                     | vault 产物                                                   | 方向       |
| --------------------------------------------------- | ------------------------------------------------------------ | ---------- |
| `Project`                                           | 目录 `<项目名>/` + `_索引.md`                                | 只出       |
| `Card`                                              | `<标题>.md`（重名才补 id 后缀）                              | 只出       |
| `Turn[]`                                            | 单问单答→ question callout + 正文；多轮→ `## 用户`/`## 助手` | 只出       |
| `CardEdge`                                          | `_关系.canvas` + frontmatter 的 `papertable_source`          | 只出       |
| `SourceAnchor` / `ContextSnapshot`                  | `> [!quote]` 块，**有损**（无损副本留在 SQLite）             | 只出       |
| `ReferenceChip`                                     | `## 引用` 的 `[[wikilink]]` 列表                             | 双向       |
| vault 笔记                                          | 新的 `ReferenceChip`                                         | 只入（S4） |
| `Proposal` / `InteractionEvent` / `SessionBoundary` | **永不写出**                                                 | —          |

## 触发与冲突

- 触发：卡片最后一条轮次转为 `status: "complete"` 后防抖 2 秒。**不跟随 500 ms 的流式
  自动保存**，那个节奏会把 vault 打烂。标题变更走 `rename` 而非删+建。`trashed` 删文件。
- **按项目 opt-in**，不是全局。
- 冲突：归一化哈希与 `last_written_hash` 不符 → 用户在 Obsidian 改过 → **不覆盖、不合并**，
  写 `<name>.papertable-conflict.md`，升常驻横幅，该卡片同步挂起，直到用户二选一。
  这是 `AGENTS.md` 的「不自动解决实质冲突、不覆盖已有知识」。这里不要耍聪明。

## S4 的环路防护（三层，缺一不可）

1. **归一化哈希比对**——唯一*正确*的一层，与时序无关。
2. **在途抑制集**，3 秒 TTL。不能作为唯一机制：macOS FSEvents 延迟批处理且目录粒度，
   事件会迟到、合并，纯抑制窗口会在负载下丢掉真实的用户编辑。
3. **逐路径 500 ms 防抖**：编辑器保存是多次系统调用，Obsidian 保存 + Linter 重写是
   毫秒级的两次独立写入。

排除：非 `.md`、任何以 `.` 开头的路径分量（`.obsidian/`、`.trash/`、`.DS_Store`——这个
vault 几乎每个目录都有 `.DS_Store`，且 Obsidian 在不停重写 `.obsidian/workspace.json`）。

入向在 v1 **永不改动** `Card` / `Turn` / `CardEdge`，只新增 `ReferenceChip`——它是纯增量的，
完全不需要冲突解决。这是整件事可控的关键。

## 实现落点

| 关注点                     | 位置                                      | 为什么在这                                   |
| -------------------------- | ----------------------------------------- | -------------------------------------------- |
| 笔记 / canvas / 索引的内容 | `src/lib/vaultNote.ts`                    | 纯字符串，能在 Node 里测                     |
| 「这次要写哪些文件」       | `src/lib/vaultPlan.ts`                    | 纯函数；与「怎么写」的失败方式完全不同       |
| 容纳、归一化哈希、冲突     | `src-tauri/src/vault.rs`                  | 只有这边读回磁盘，哈希必须只有一份实现       |
| `sync_state`               | `src-tauri/src/db.rs` + schema v2         | 冲突挂起要跨进程重启存活                     |
| 触发与 UI                  | `src/store.tsx`、`Dialogs.tsx`、`App.tsx` | 完成后防抖 2 秒；按项目 opt-in；常驻冲突横幅 |

**可导出的判据是「这条 AI 轮次没有出问题」，不是「它被标成了 complete」。** `Turn.status`
是可选的：导入的、demo 播种的、早期版本留下的轮次都没有这个字段。要求
`status === "complete"` 会把它们全部悄悄排除——真机表现是开了同步却一个文件都不写，
而且不报错。
