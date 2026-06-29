# T06 — 计算引擎

**状态**：✅ 完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：纯函数算 BMR/TDEE 与单条食物热量。
**依赖**：T01　**关注文档**：CALORIE_ENGINE（公式唯一来源）

## 做什么
- `backend/src/services/calc.ts`：`bmr(user)`、`tdee(user)`、`itemNutrition(foodRow, weight_g)`、`dailyTargets(user)`，全部纯函数，按 CALORIE_ENGINE 口径。
- 配单元测试。

## 验收
- 给定档案的 BMR/TDEE 与手算一致。
- food 行 + 克数 → kcal/三大营养素正确。
- 营养字段 null 不崩。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/CALORIE_ENGINE.md。只做任务 T06：实现计算引擎纯函数(BMR/TDEE/单条营养/每日目标)并写单元测试。公式严格按 CALORIE_ENGINE，不要自创。
