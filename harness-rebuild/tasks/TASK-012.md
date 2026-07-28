---
id: TASK-012
title: 拖放附件全生命周期（独立并行线）
status: pending
depends_on: [TASK-003]
parallelizable: true
isolation: outputs/task-012/
merge_strategy: human-review
verify: 拖文件/文件夹→当前卡片附件（体积与数量护栏、超限先确认、进度UI）；快照进应用存储，绝不写原文件；独立索引 scope=attachment:cardId，默认仅当前卡片可搜；模型无法传scope（schema无该字段+宿主冻结测试）；Rust侧readableIds校验拒绝未检索chunk；实际读取后可引用；删除附件→历史回答保留冻结摘录并显示"原来源已移除"；显式操作才可提升为项目资料库
---

## 任务内容
按 ADR-004/005 实现：Tauri onDragDropEvent 接入 → 体积检查 → 快照拷贝 → 附件索引（与正式库表隔离）→ 宿主冻结作用域 → 引用与幽灵来源治理（扩展 controlledCitations）→ 提升动作。Rust 侧补 readableIds 数据层校验（此项为全局加固，不限附件）。

## 输入
ADR-004/005；sources/research/papertable.md §4-5。

## 预期输出
附件管线 + 双侧校验 + 幽灵来源展示 + 测试。
