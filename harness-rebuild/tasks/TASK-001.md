---
id: TASK-001
title: Pi 桥接 spike（限时半天）
status: done
depends_on: []
parallelizable: false
isolation: outputs/task-001/
merge_strategy: human-review
verify: outputs/task-001/spike-report.md 存在，四个问题各有基于可运行代码的明确结论，并给出"依赖引入 / 仅移植模式"最终建议及理由
---

## 任务内容

用最小代码验证 pi-agent-core 能否作为依赖接入。严格限时半天，不追求完善。
四个必答问题：

1. 能否通过现有 Rust 模型通道（注意：密钥在 0600 权限 provider.json，非 Keychain）驱动云端旗舰模型完成一轮带工具的调用；
2. tool call 与流式事件到 pi 事件协议的转换成本；
3. 中止、重试、恢复能否接入其回调外置的终止机制；
4. 引入后代码更简单还是更绕。

## 输入

sources/research/pi.md（五层架构、§4.5 浏览器打包、§8 安全冲突清单）；Papertable 现有 llm.rs 通道。

## 预期输出

outputs/task-001/spike-report.md + 可丢弃的试验代码。结论直接决定 TASK-004 的实现形态。

## 边界

不引入 pi-coding-agent；不使用 createReadOnlyTools（会 spawn 子进程/下载二进制）。

## 发现

- 结论与可运行证据见 `outputs/task-001/spike-report.md`；最终建议为仅移植模式，不引入运行时依赖。
- 真实 Rust 通道能收到并提交工具调用，但当前旗舰模型的收尾不稳定：连续探测结果在 `native-tools` / `two-stage` 间变化，且观察到提交工具结果后仍重复 `search_notes`、没有最终正文。
- 卡外风险已记录但未修复：Rust 流缺 usage，Tauri TS 包装层丢弃 `stopped`，Pi core 无 Papertable 所需的预算与重复调用/无进展闸门。
