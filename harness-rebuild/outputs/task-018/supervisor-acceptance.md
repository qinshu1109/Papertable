# 判决簿最终监督验收

- 日期：2026-07-29
- 分支：`task/TASK-014-verdict-memos`
- 基线：`41c915e`
- 结论：**CONDITIONAL NO-GO**

## 卡片结论

| 卡片     | 技术验收                             | 权威状态                        |
| -------- | ------------------------------------ | ------------------------------- |
| TASK-014 | 通过                                 | `in_progress`，待提交/PR/合入   |
| TASK-015 | 通过（监督验收中修复组合检索漏召回） | `in_progress`，待提交/PR/合入   |
| TASK-016 | 通过                                 | `in_progress`，待提交/PR/合入   |
| TASK-017 | 通过                                 | `in_progress`，待提交/PR/合入   |
| TASK-018 | 实现与确定性门禁通过                 | `in_progress`，真实事件门未满足 |

## 监督验收修复

1. `buildVerdictQuery` 原先最多保留 80 字符，长问题可能截掉卡片标题和概念；
   现在在 500 字符内公平保留问题、标题和概念。
2. Node/Rust host 原先把组合查询当成一个完整子串匹配，短概念把手可能漏召回；
   现在支持“查询包含已存概念”的宿主复核，并有组合查询与实时 MCP 回归。
3. Node/Rust DTO 现在强制 `gold → turn + card/turn`、`tombstone → edge`，
   supersede 必须保持项目、类型及完整来源不变。
4. 事件结算不再依赖手工导出：`acceptance:task-018:desktop` 只读安装版
   SQLite，逐行核对列值与 JSON，并按项目和分支卡去重；孤立确认和重复重试不计数。

MemOS MCP 当前把 `top_k` 限制为 50 且没有分页 cursor，因此项目判决超过 50 条后
存在窗口上限。这不是当前事件门的阻塞项，但在 MemOS 提供分页前不得宣称无限账簿。

## 独立复跑

- `pnpm verify`：257/257 Node/TS/server，97/97 Rust，Web build 通过。
- `pnpm test:e2e`：40/40。
- Debug `.app`：重新构建、ad-hoc 签名并安装；真实桌面启动、继续探索、项目切换默认
  判决簿均通过。
- strict Clippy、live Rust→MemOS、L2 workspace validator、`git diff --check`：
  全部通过。
- 非阻断警告：Web 主 chunk 超过 500 kB。

## 不放行原因

以下证据不能由测试夹具或自动点击伪造：

- 没有用户预先冻结的 10 个真实老问题与复发判定表，真实旗舰 A/B 未运行；
- 安装版真实数据库为 0/20 次 eligible 改道；
- 前 10 条墓碑草稿为 0/10，无法结算大改/放弃率。

因此 TASK-018 不能设置 `done`，整个判决簿候选也不能发布。保持真实使用累计，达到
样本量后用 `acceptance:task-018 --desktop-db=auto` 原样结算。
