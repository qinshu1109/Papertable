---
id: TASK-014
title: 判决簿 ADR、MemOS 契约与外接通道
status: in_progress
depends_on: []
parallelizable: false
isolation: outputs/task-014/
merge_strategy: human-review
verify: ADR-008 以 accepted 状态归档并链接 INPUT-20260729-001；papertable-verdicts Cube 可幂等创建；Web/Node 与 Desktop/Rust 均能经现有 HTTP MCP 完成 health、按项目列出/检索、幂等确认、supersede，且客户端无删除能力；confirmed、项目隔离、单行上限、brain/hot 排除、locked_fields 与备份恢复均有契约测试和证据
---

## 任务内容

把用户已确认的判决簿决策落成 ADR-008，并先打通不依赖 UI 的 MemOS 外接边界。默认复用当前 `http://127.0.0.1:8002/mcp` 工具协议，不新增 MemOS SDK，也不改 MemOS 服务；只有可运行 spike 证明 HTTP MCP 无法稳定支持 Node 与 Rust 时，才在本卡记录证据并改为 MemOS 窄 REST 接口。

建立独立 Cube `papertable-verdicts`。判决使用 `semantic_type=decision`、`subject_id=projectId`、`client_id=papertable`，并写入 `verdict_type`、概念、来源 id、`user_confirmed`、幂等键等 attributes。统一使用 `hot_policy=exclude`、`brain:ignore` 标签和非空 `locked_fields`；修订只新增带 `supersedes_memory_id` 的记录，不暴露删除入口。

Web 端经本机 Node 服务调用，桌面端经 Rust 调用；两端输出同一份宿主中立的安全 DTO。幂等键至少覆盖“同一项目 + 判决类型 + 来源 edge/turn”，重复确认返回已有记录。

## 输入

- [INPUT-20260729-001](../sources/INPUT-20260729-001.md)
- 现有 MemOS HTTP MCP、Schema v2、`tools/memos_backup.py`
- `src/lib/memory.ts` 的 Noop 边界
- Web 本机服务与 Tauri/Rust 双通道现状

## 预期输出

- `decisions/ADR-008-判决簿.md` 与 ADR 索引更新
- 判决 DTO、校验器及 Web/Rust 外接通道
- Cube 幂等建库/健康检查与 supersede-only 契约
- `outputs/task-014/` 下的契约、双通道、备份与隔离恢复证据

## 边界

- 本卡不接入 `buildContext()`，不改改道、采纳或判决簿 UI。
- 不新建本地判决表，不做离线写队列；MemOS 是唯一真值。
- 不使用通用 `delete_memory`，不让模型接触记忆写接口。
- 不修改现有 Harness 工具 schema、资料库 scope 或引用资格。
- 若实际操作需要修改 `/Users/qinshu/Documents/MemOSjyi`，必须停止本卡并由监督者拆出独立仓库任务，禁止一张卡跨两个 Git 仓库提交。

## 重点验收

1. 两个项目使用相同概念时不得互相召回。
2. 双击确认、网络重试及本地落盘失败重试不得重复铸币。
3. supersede 后只返回链尾用于注入，旧记录仍可列出。
4. 判决 Cube 能进入现有无密钥快照并通过隔离恢复校验。
5. MemOS 不可用时返回明确不可用状态，不伪造空成功。
