# T36 — 上下文补全：week/month 聚合注入 + L0 时间标注（对话智能）

**状态**：⬜待办

**目标**：AI 回答周/月问题时手里有真实数据（不再编）；隔夜对话不再被当成"刚刚说的"。
**依赖**：T22（对话记忆包已完成）　**关注文档**：AI_PARSING_SPEC §6 §7

## 背景（为什么会有这个任务）

2026-07-03 体检发现两处上下文缺口：

1. **算了但没喂**：`buildContextCard`（summary.ts）认真算了 `week.avg_deficit / week.logged_days / month.avg_in / month.logged_days`，但 `compressContext`（ai/ctx.ts）从头到尾没输出这两组数据。而 `answerQuery` 的 system prompt 声称"根据本周/月均值回答"——用户问"我这周平均缺口多少"，AI 只有近 3 天明细，只能编或含糊，被感知为"笨"。
2. **L0 无时间概念**：`buildMemoryPack` 取 `ai_parse_log` 最近 8 条**不过滤日期**、行内**无时间戳**。隔夜打开 App，昨晚的对话以【最近对话】身份出现，"续报跟随上一餐"等规则会被昨天的餐带偏。

顺带修一处注释漂移：memory.ts 中两处注释写"近7天"，实际查询窗口是 3 天（与 AI_PARSING_SPEC §6"近3天"一致，以规范为准，改注释）。

## 做什么（指引，不限定实现细节）

- `ai/ctx.ts` `compressContext`：在【今日进度】之后输出周/月两行，如：
  `【本周】平均缺口X kcal 已记录N天`、`【本月】平均摄入X kcal 已记录N天`（数据取自 pack.card.week / pack.card.month，已有，无需新查询）。
- L0 时间标注：`TurnSummary` 增加 `at`（取 ai_parse_log.created_at）；compressContext 渲染为相对时间前缀——今天的显示 `HH:mm`，昨天显示 `昨天HH:mm`，更早显示 `M月D日`（北京时间口径与 todayStr 一致）。
- memory.ts 注释"近7天"→"近3天"（两处）。
- AI_PARSING_SPEC §7 的 compressContext 压缩文本示意同步补【本周】【本月】与时间标注（规范与实现对齐）。

## 验收

- 单测：compressContext 对含 week/month 数据的 pack 输出包含【本周】【本月】行；对跨天的 recent_turns 输出正确的相对时间前缀（今天/昨天/M月D日 三种）。
- 手测：问"我这周平均缺口多少"，AI 回答的数字与 Today/History 口径一致，不再含糊或编造。
- 手测：昨天有对话、今天首次发消息，解析不把昨天的餐当成"刚才那餐"续报。
- 现有测试全绿；token 增量可忽略（新增行数 ≤ 4 行文本）。
