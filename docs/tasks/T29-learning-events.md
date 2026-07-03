# T29 — 学习事件采集（P1：纯旁路记录，零行为变化）

**状态**：✅完成

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

## 实现记录（非显而易见的坑）

- **delete hook 的写入顺序是坑**：`learning_event.food_record_id` 有外键约束（`onDelete: SetNull`）。如果先 `deleteMany` 食物记录再写 learning_event，INSERT 会因为外键指向不存在的行而失败（被 `recordLearningEvent` 的静默 catch 吞掉，表现为"事件从未被记录"，且不报错很难查）。正确顺序：**先查出待删记录 + 写 learning_event（await），再执行 delete**——`ON DELETE SET NULL` 会在随后的删除中把这条刚写入的事件的 `food_record_id` 自动置空，历史行本身完整保留。实测验证：删除后按 `food_record_id` 查为 0 行（正常，FK 已置空），按 `user_id` 查能看到 3 条事件（card_choice/explicit_gram/delete）且 `food_record_id` 均为 null。
- **`portion_choice` 的 pending candidates 原本不存 `chosen_label`**（只有 `food_choice` 类型存），要算"AI 预测克数"就没有基准。改动：`food-item.ts` 生成 portion_card 时、以及 `pending.ts` 里 food_choice→portion_choice 两步转换时，都把 `chosen_label` 顺手带进 candidates——纯加字段，不影响任何现有消费方。
- **体重 upsert 只在真变化时触发**：PUT 前先查一次旧值比较，而非每次 PUT 都无条件 upsert，避免用户提交整份 profile 表单（未必是来改体重）时产生噪声数据点。
- **"每日一次"的隐式确认 job 没有接入进程内调度器**：项目目前没有任何 cron/scheduler 依赖，ARCHITECTURE §6 对聊天保留清理任务的设想也是"部署平台的 cron（或后端内置调度）"、尚未实现。为了不引入新依赖或架子决策，落地成 `scripts/implicit-accept-job.ts` 独立脚本（`npm run job:implicit-accept`），可被外部 cron 调用；job 天然幂等（只扫"无 learning_event"的记录）。
- 已用真实开发服务器跑通全部 4 个 hook + 体重 upsert + job 幂等性，数据与预期完全一致（含 log_ratio 数值核对）。
