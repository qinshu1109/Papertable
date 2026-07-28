---
source_type: user_input
captured_at: 2026-07-28T07:53:00+08:00
processed_by: perplexity-computer + codex 讨论合成
---
# 来源说明

本工作区由三部分输入合成：
1. 2026-07-28 会话中用户的六项产品决定：仅云端旗舰原生工具、不允许降级、预算耗尽保留证据出未完成答案、探索预算产品化、过程完整持久化、拖入材料默认为当前卡片可索引可引用可提升的附件。
2. Perplexity Computer 的 P0-P6 建议（基于 sources/research/ 四份代码级分析）。
3. Codex 对该建议的修正稿（用户贴回），关键修正：收尾协议失败不得包装为 partial（ADR-003）；轨迹节点无引用资格（ADR-004）；结果×原因两轴（ADR-002）；按错误类别分流重试（ADR-007）；作用域宿主冻结（ADR-005）；sources-only 部分答案边界与续跑工作集压缩规则（ADR-004/006）。
4. 事实勘误：Papertable 已移除 Keychain，密钥存于 0600 权限 provider.json（影响 TASK-001 评估）。

完整分析报告见 sources/research/{papertable,pi,dg-ai-notes,openhanako}.md。
