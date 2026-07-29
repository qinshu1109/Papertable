---
id: TASK-016
title: 改道墓碑的起草、确认与首轮门禁
status: in_progress
depends_on: [TASK-015]
parallelizable: true
isolation: outputs/task-016/
merge_strategy: human-review
verify: 所有改道入口保持既有 context cutoff 语义；仅在 cutoff 后存在被砍完整轮次时起草一句 proposed 墓碑；新分支先持久化但首次回答必须等待用户确认/改写/跳过；确认成功写 MemOS 后本轮立即可注入，跳过/关闭/起草失败不写入；写失败可重试或跳过且不撤销分支；前10条的大改/放弃统计可核验
---

## 任务内容

把墓碑生命周期接到所有现有改道入口的共同边界。创建 branch edge、快照与新卡仍沿用当前语义；从 `contextCutoffTurnId`（缺省时按当前分支规则解析）之后截取被砍的完整用户/助手轮次，作为起草材料。没有被砍历史时不伪造否决，只按普通分支继续。

新增非流式功能任务 `verdict-draft`，Web 与 Rust 使用同一输出契约，只返回一句墓碑草稿。草稿为临时 `proposed` UI 状态，不写 SQLite 或 MemOS。分支卡先可靠落盘，但其 seed 问题不得自动开始生成，直到用户执行以下任一动作：

- 确认：按原文写入 MemOS；
- 改写并确认：写用户最终一行；
- 跳过/关闭：不写入，继续生成；
- 写入失败：保留草稿，允许重试或明确跳过。

确认成功后，新分支首次回答必须使用 TASK-015 的检索入口，能命中刚确认的墓碑。记录 eligible reroute、confirmed、rewritten、abandoned 四类本地实验事件，用于 20 次改道确认率和前 10 条起草质量结算。

## 输入

- ADR-008
- TASK-015 判决检索与冻结注入
- `src/store.tsx` 的 `createCard()`、`rerouteEditedQuestion()` 与生成前落盘门禁
- `src/components/CardStage.tsx` 的全部改道入口
- Web/Rust 功能模型任务 allowlist

## 预期输出

- 被砍历史的确定性提取函数与测试
- `verdict-draft` 双通道起草任务
- 墓碑确认/改写/跳过弹窗与首次回答门禁
- 墓碑实验事件和聚合统计
- `outputs/task-016/` 下的各入口、故障、重试、空后缀和首轮注入证据

## 边界

- 不改变 branch 的冻结历史、`sourceTurnId`、`contextCutoffTurnId` 或移动轮次语义。
- proposed 草稿永不持久化，只有用户确认动作可产生 confirmed。
- 起草失败不能撤销已经创建并持久化的分支。
- 不做金子采纳、判决簿首页或自动从普通对话提取墓碑。
- 不让墓碑起草任务获得资料库工具或 MemOS 写权限。

## 并发护栏

本卡与 TASK-017 只有在文件重叠预检通过时才可并发。两者预计都会触碰 `store.tsx`、`CardStage.tsx`、功能任务 allowlist 和共享类型；任一共享热点无法在 TASK-015 既有接缝内隔离时，本卡自动回退串行。并发时必须独立 worktree，且先合入的一卡成为另一卡 rebase 与全量 verify 的新基线。
