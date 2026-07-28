# ADR-003: completed_partial 与 protocol_error 的分界

- 状态: accepted
- 日期: 2026-07-28
- 来源: Codex 方案修正，用户认可

## 背景
最初方案把"收尾调用失败"也包装成 partial，会让协议故障冒充完成。

## 决策
- 预算耗尽 + 同一旗舰模型成功完成证据综合 → result=partial
- 收尾首次失败，经同协议修复后成功 → 仍为 partial
- 修复重试全部失败 → result=failed, reason=protocol_error；保留证据与轨迹，不得产出伪装答案

## 不变量
- partial 的综合调用必须真实成功且答案标注"探索未完成"与已耗预算
- failed 状态下已读证据与事件轨迹完整落盘，可续跑

## 违反后果
协议故障被计为完成，验收矩阵失真。

## 文件引用
src/lib/agent.ts:749-762、store.tsx:1540-1563
