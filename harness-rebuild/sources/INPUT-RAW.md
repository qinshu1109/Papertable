---
source_type: prompt
captured_at: 2026-07-28T08:22:36+08:00
processed_by: init-ai-project-workspace
content_sha256: 423271a79d3706ea8029ac84e07e523688339943beaa1c6bf719f52c8a20d7d2
---

# 原始输入

/Users/qinshu/Downloads/papertable-harness-rebuild-workspace.zip 这是fable-5给出的压缩包文档，有多个卡片，然后怎么用WenzMark来指行？
fable-5给出的回答
## 对 Codex 方案的评审：OK，两处修正都应采纳

- **"收尾协议失败不得包装成 partial"——完全正确**，这是我原方案的真实漏洞。修复成功才算 partial，修复耗尽必须是 protocol_error，否则验收矩阵会把协议故障计为完成。
- **"轨迹节点无引用资格"——正确且必要**。"搜索过某句话"和"读到的原文片段"是两种证据等级，混了产品就退化成不可信 RAG。
- **结果×原因两轴**比我的平铺枚举好，"因为轮次耗尽所以给出部分答案"只有两轴才表达得出来。
- **按错误类别分流重试、作用域宿主冻结、工作集压缩与完整历史分离**——都对。

我补了四个 Codex 没提的加固点（已写进包里）：①两轴需要**合法组合表**并在类型/测试层拒绝非法组合（如 completed+protocol_error），否则两轴自由组合会状态爆炸；②事件行要带 **schema\_version**，旧 turn 保留为 legacy 只读不回填；③流式参数重组必须**只做无损操作**，有歧义一律要求重发，不做启发式补括号；④**TASK-001 spike 必须先行**，因为"依赖 pi 还是移植模式"直接决定状态机那张卡的实现形态。

## 已交付：可直接执行的工作区包

上面的 zip 解包后把 `harness-rebuild/` 放进 Papertable 仓库（建议就放在 feat 分支根目录），结构完全符合你们那套 v2 skill：

- **7条 ADR**（全部 accepted，来源可溯——都是你本轮明确拍板的决定），是 Codex 的硬约束层；
- **13张任务卡**，每张带 `depends_on / verify / isolation / merge_strategy`，verify 全部是客观判据（含你那次故障拆成的两个固定用例：耗尽+收尾成功→partial，耗尽+修复失败→protocol_error）；
- **ORCHESTRATION.md**：主干串行 002→003→004→(005/006/007)→008/009/010→011→013，spike 和拖放附件线（012）可并行；011（删除双阶段）是唯一删除卡，前置全绿+你确认才开工；
- **四份代码分析报告**原样放在 sources/research/，Codex 按卡内引用的小节按需查阅，不用整读；
- 事实勘误（provider.json 0600、非 Keychain）已写进 INPUT-RAW 和 TASK-001。

## 怎么让 Codex 执行得有条理

核心纪律就三条，都已写进包里的 AGENTS.md：

1. **一卡一跑**：每次 Codex 运行只给它一张任务卡。读取顺序 CONTEXT→CURRENT→本卡→依赖卡产物→引用的 ADR，其余不加载。卡外发现只许记录（candidates/），不许顺手修——这是防"误改扩散"的关键。
2. **verify 即验收**：每卡的 verify 判据全绿才能置 done，测试和实现同卡交付。你验收的是 PR + verify 清单，不用读全部 diff。
3. **金样随卡沉淀**：从 TASK-004 起每卡把关键事件流存为 fixtures，013 只是收口。这样状态机语义被悄悄改动时回放测试会报警。

另外一个顺水推舟的建议：这13张卡的格式正好是 WenzMark 任务中心吃的那种"md任务清单+验收"——你可以直接用它来派发和跟踪这些卡给 Codex，等于用你自己评测过的工具跑你自己的项目，顺便验证它是不是伪需求。
