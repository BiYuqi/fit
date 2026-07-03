# T33 — 估算食物复核（P5：AI 兜底条目越吃越准）

**状态**：✅完成

**目标**：`is_estimated=true` 的食物是 flash 一次性瞎估的营养，之后被反复使用却从不复核。对高频估算条目定期用 pro 模型带聚合上下文重估 + 类目均值合理性校验。
**依赖**：T29　**关注文档**：LEARNING_SPEC §3、FOOD_DB_SPEC（三层结构）

## 做什么
- 周期 job（可与隐式确认 job 同宿）：找「is_estimated=true 且 food_record 引用次数 ≥ 3 且未复核过」的 food_standard。
- 对每条：用 `deepseek-v4-pro` 重估每 100g 营养（带该食物名、类目、被记录时的 raw_input 样本、同类目营养均值区间作参照；纯食物知识调用，走 `callDeepSeek` 不带用户上下文）。
- 合理性护栏：新值需过能量自检（4/4/9 口径，同 T03）；与类目均值偏离超 3 倍则放弃更新、标记人工复核。
- 更新 food_standard（`source='ai_reviewed'`，is_estimated 保持 true），**不回改历史 food_record**（历史记录是当时事实）；变更写日志表或复用 bias_update_log 风格的简单记录。

## 验收
- 构造一个被引用 3 次的估算食物 → job 后营养被 pro 重估、source=ai_reviewed；能量自检不过的条目不更新。
- 历史 food_record 的 calories 不变；此后新记录按新营养计算。
- job 幂等：复核过的条目不重复调用。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/LEARNING_SPEC.md、docs/FOOD_DB_SPEC.md。只做任务 T33：估算食物复核 job（引用≥3 → pro 重估 + 能量自检护栏 + source=ai_reviewed），不回改历史记录，幂等。
