# T03 — 食物库导入与清洗

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：把约 1677 条食物灌进 food_standard，含数据清洗与能量自检。
**依赖**：T02　**关注文档**：FOOD_DB_SPEC，backend/scripts/seed/seed_food_standard.ts

## 做什么
- `git clone --depth 1 https://github.com/Sanotsu/china-food-composition-data`，用 `json_data_vision_251206_Qwen2-5-VL-72B-Instruct` 目录。
- 跑 seed 脚本（已实现清洗：`"Tr"`/空→null、食部%/100、按文件名取 category、去重）。
- **能量自检**：脚本对每条用 4P+4C+9F 反推能量与标注比对，偏差>25% 写入 `review_flags.csv`。
- 先 `--dry` 干跑→复核 review_flags.csv→正式 upsert（按 name+category 唯一键）。

## 验收
- food_standard 约 1677 行。
- review_flags.csv 生成，抽查米饭/鸡蛋/鸡胸肉/牛奶/苹果能量合理。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/FOOD_DB_SPEC.md。只做任务 T03：clone 食物数据仓库，用 backend/scripts/seed/seed_food_standard.ts 先 --dry 干跑生成 review_flags.csv，再正式导入 food_standard。做完报告导入条数并抽查 5 个常见食物能量值。
