# FOOD_DB_SPEC — 食物库领域规范

> 讲食物库的"是什么/规则"。**导入与清洗的具体步骤、命令、验收在 `docs/tasks/T03-seed-food-db.md`**，本文件不写操作步骤。字段见 DATA_MODEL。

## 1. 数据源
主源：开源仓库 `Sanotsu/china-food-composition-data`，将官方《中国食物成分表 标准版 第6版》（杨月欣主编，北大医学出版社）的"能量和食物一般营养成分"部分识别为 JSON。
- 用目录 `json_data_vision_251206_Qwen2-5-VL-72B-Instruct`（约 **1677 条**，已剔除婴幼儿品牌奶粉）。
- 每条为每 100g 可食部数值：能量、蛋白、脂肪、碳水、膳食纤维、食部等。

补充源（可选，按需）：USDA FoodData Central（CC0，补西式单一食材）。

## 2. 字段映射（概念）
源 `foodName→name`、`edible(%)→edible_ratio(/100)`、`energyKCal→calories_100g`、`protein/fat/CHO/dietaryFiber→对应 _100g`，类目从源文件名提取。
> 具体清洗规则（"Tr"/空→null 等）与代码在 T03 任务与 `backend/scripts/seed/seed_food_standard.ts`。

## 3. 三层结构
1. **标准层**：单一食材 + 标准食品，来自上述 1677 条。**后端算账只用这层，纯查表，准确度高。**
2. **复合菜层**：成分表没有的菜（麻辣烫、黄焖鸡、煎饼果子等）。由 DeepSeek 估算，打 `is_estimated=true`、`is_composite=true` 落库，下次即变查表。
3. **AI 兜底层**：完全无匹配时，DeepSeek 现场估三大营养素 → 落库成低可信新条目复用。

匹配如何在三层间流转见 AI_PARSING_SPEC §匹配管线。

## 4. 准确率
源为机器识别，不保证逐条准确。因此导入必须做**能量自检**（用三大营养素反推能量，与标注值比对，超阈值挑出人工复核）。原则在此，实现与阈值在 T03。

## 5. 版权与商用
底层成分表版权归出版社。**营养数值是事实可用，但整表汇编有权利**。
- 个人 / MVP：用开源转录数值是常规做法。
- 商业上量：应改为购买官方电子版授权，或接商业营养 API（如薄荷健康），或就汇编权单独评估。
