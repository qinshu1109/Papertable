# ADR-004: 引用资格与 sources-only 边界

- 状态: proposed
- 日期: 2026-07-28
- 来源: [INPUT-RAW](../sources/INPUT-RAW.md) 中 Fable-5 转述；待用户确认

## 背景

搜索轨迹不能被误当作已读证据。

## 决策

引用只能指向实际读取的片段。轨迹可查看、恢复和提升，但无引用资格。sources-only 仅在已读相关材料、同模型综合成功、只使用已读材料且标注覆盖不全时允许 partial；只有命中、材料无关或证据不足时拒答。综合修复失败按 ADR-003。

## 不变量

- 保留并扩展 controlledCitations。
- 搜索元数据永不产生引用。

## 违反后果

引用会被轨迹污染。

## 文件引用

- [原包全文](../sources/original-package/decisions/ADR-004-引用资格与sources-only边界.md)
