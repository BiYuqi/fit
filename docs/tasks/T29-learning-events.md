# T29 — 学习事件采集（P1：纯旁路记录，零行为变化）

**状态**：⬜待办

**目标**：把已存在但被丢弃的交互数据落成训练样本：预测克数 vs 用户最终克数。本任务**只采集不应用**——用户无任何感知，为 T30/T31 攒数据、为"越用越准"建基线指标。
**依赖**：T28　**关注文档**：LEARNING_SPEC §1 §3 §9、DATA_MODEL §学习系统表

## 做什么
- Prisma 迁移：建 `learning_event` + `weight_log`（字段见 DATA_MODEL）。
- 新建 `services/learning.ts`：`recordLearningEvent(ev)`（算 log_ratio 落库；异常吞掉不影响主流程）。本阶段 `applied_grams = predicted_grams`（applyBias 尚不存在）。
- 四个旁路 hook（LEARNING_SPEC §3 权重）：
  1. **resolve portion_choice**（routes/pending.ts）：predicted = pending candidates 里 AI 的 chosen_label 档克数；final = 用户所选；`custom_gram`(0.9) / `card_choice`(0.6)。
  2. **modify update**（services/intents/modify.ts）：predicted = prev_state.weight_g；final = 新克数；`explicit_gram`(1.0)。改食物（change.food）不产生克数事件。
  3. **delete**（resolve delete_confirm）：`signal_type=delete, weight=0`，只记不训练。
  4. **隐式确认 job**：每日跑一次，扫「入库超 24h、未被 modify/删除、无同 record 的 learning_event」的 food_record → `implicit_accept`(0.15)，predicted=final=weight_g。
- **体重历史**：用户档案更新接口里，weight_kg 变化时 upsert `weight_log(user_id, 今日, weight_kg)`。
- 指标脚本（可 npm script）：按周输出 `|log_ratio|` 中位数（LEARNING_SPEC §9 基线）。

## 验收
- 走一遍：份量卡选小份、卡片自定义输入克数、"改成50克"、删除、设置页改体重 → learning_event / weight_log 各出现正确行，signal_type/weight/log_ratio 正确。
- 高置信自动入库的记录 24h 后被 job 补 implicit_accept（测试可把阈值调成 0）。
- 所有现有接口响应与 T28 后完全一致；learning 写失败（如表锁）不影响主流程返回。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/LEARNING_SPEC.md §3、docs/DATA_MODEL.md 学习系统表。只做任务 T29：建 learning_event/weight_log 表 + services/learning.ts + 四个旁路 hook + 体重 upsert + 周指标脚本。只采集不应用，主流程零行为变化，learning 写入失败须静默。
