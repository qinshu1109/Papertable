---
id: TASK-017
title: 金子的显式采纳与概念把手
status: in_progress
depends_on: [TASK-015]
parallelizable: true
isolation: outputs/task-017/
merge_strategy: human-review
verify: Web 无效“收藏本轮”和 Desktop 整轮右键入口均变为真实“采纳本轮”；只有已完成 AI Turn 可采纳；模型从该轮起草一行结论，用户必须亲手填写非空概念把手并确认；MemOS 成功后才设置 Turn.favorite/关联 verdict id；取消、起草失败、写失败均不铸币；重复采纳幂等，修订只 supersede；项目和来源定位测试通过
---

## 任务内容

把已有但未接线的 `Turn.favorite` 变成金子的本地采纳标记，卡片收藏语义保持不变。网页端将无效“收藏本轮”替换为“采纳本轮”；桌面端在整轮回答右键菜单加入同一入口。流式、停止、错误或空回答不能采纳。

采纳弹窗包含：

1. 模型根据被采纳 Turn 起草的一行结论，可由用户修改；
2. 用户必须亲手填写的一行概念把手；
3. 明确“确认采纳”动作。

确认后写入 `gold` 判决，保存结论、把手、项目、来源 card/turn、概念和幂等键。只有 MemOS 返回成功或幂等已有记录后，才设置 `Turn.favorite=true` 并保存关联 verdict id。再次修改不能覆盖旧记录，必须新增 supersede 版本。

金子起草可复用 TASK-016 已存在的 `verdict-draft`；若与 TASK-016 并发，则使用 TASK-015 已约定的通用功能任务接缝，不得各自发明不同协议。

## 输入

- ADR-008
- TASK-015 判决外接、注入、持久化和审计
- `Turn.favorite` 的 Web/SQLite 现有字段
- `src/components/CardStage.tsx` 的 Web 更多菜单与 Desktop 整轮菜单

## 预期输出

- Web/Desktop 一致的“采纳本轮”入口
- 一行结论 + 用户概念把手确认弹窗
- gold 幂等写入、本地成功标记与 supersede 修订
- 采纳资格、失败恢复、项目隔离和格式往返测试
- `outputs/task-017/` 下的确认、取消、重试、重复和修订证据

## 边界

- 不复用或改写 `Card.favorite`，不把收藏卡片自动升级为金子。
- 用户未填写概念把手时禁止写入。
- 不保存未确认的结论草稿，不自动扫描历史回答采金。
- 不把整篇 AI 回答复制为一条无界判决；最终 durable 内容必须是用户看过的一行结论与把手。
- 不做判决簿首页、复习、掌握状态或知识图谱。

## 并发护栏

本卡与 TASK-016 逻辑独立但共享 UI/Store 热点。只有监督者完成只读重叠预检、确认改动可隔离并建立独立 worktree 后才并发；否则按 TASK-016 → TASK-017 串行。并发合入后必须重跑双方聚焦测试和 `pnpm verify`。
