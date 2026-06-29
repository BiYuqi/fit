# T10 — 每日汇总 + 上下文卡

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：写记录后重算 daily_summary，并产出查询用上下文卡。
**依赖**：T06 T09　**关注文档**：DATA_MODEL daily_summary，AI_PARSING_SPEC §6，CALORIE_ENGINE §4

## 做什么
- `backend/src/services/summary.ts`：`recompute(user_id, date)` 汇总当日 food/exercise 写 daily_summary。
- `buildContextCard(user_id)`：产出 today/week/month/targets 聚合卡（只聚合值）。

## 验收
- 加一条记录后 today 汇总数值正确；上下文卡结构符合 AI_PARSING_SPEC。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/CALORIE_ENGINE.md、docs/AI_PARSING_SPEC.md。只做任务 T10：实现 daily_summary 重算与上下文卡构建。验证记录后汇总正确、卡结构对。
