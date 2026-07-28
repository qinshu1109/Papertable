# ADR-003: partial 与协议错误分界

- 状态: proposed
- 日期: 2026-07-28
- 来源: [INPUT-RAW](../sources/INPUT-RAW.md) 中 Fable-5 转述；待用户确认

## 背景
收尾调用失败不能冒充部分完成。

## 决策
- 预算耗尽且同一模型成功综合 → partial。
- 同协议修复后综合成功 → partial。
- 修复耗尽 → failed/protocol_error，保留证据与轨迹，不产出伪答案。

## 不变量
- partial 必须来自真实成功的综合并标注未完成。
- failed 仍完整保存证据与轨迹。

## 违反后果
协议故障会被错误计为完成。

## 文件引用
- `src/lib/agent.ts`、`src/store.tsx`
- [原包全文](../sources/original-package/decisions/ADR-003-partial与协议错误分界.md)
