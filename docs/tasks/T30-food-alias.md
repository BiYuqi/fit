# T30 — 用户食物直连（P2：记住"他的煎饼=煎饼果子"，跳候选卡）

**状态**：✅完成

**目标**：用户在 CandidateCard 连续 2 次把同一 canonical 选成同一食物后，第 3 次不再弹卡、直接入库——用户感知最强的"它记住我了"。**必须配逃生口与 undo 联动，否则学错一次用户被错误映射永久困住。**
**依赖**：T29　**关注文档**：LEARNING_SPEC §6 §7、DATA_MODEL user_food_alias

## 做什么
- Prisma 迁移：建 `user_food_alias`。
- **写**（routes/pending.ts resolve food_choice）：upsert `(user_id, canonical)`——选同一 food_id 则 hits+1、streak+1；选了别的则改指向、streak=1。canonical 从 pending candidates.query 取。
- **读**（services/food-item.ts processFoodItem）：进入歧义判定前查 alias，`streak ≥ 2` → 跳过 CandidateCard，用该 food_id 走正常份量流程（份量不确定仍出 PortionCard，不越权）。
- **逃生口**：习惯直连入库的 record_card payload 加 `matched_by_habit: true` + `escape:{canonical}`；前端卡片显示"已按你的习惯记为「X」"+「不是它？」按钮 → 调新端点 `POST /api/learning/alias/reset`（body: canonical），streak 清零并重新走一次该输入的候选流程（重发 CandidateCard）。
- **联动清 streak**：① undo 撤销 matched_by_habit 的记录；② modify update 带 change.food 改掉该记录的食物。
- API_SPEC 补 reset 端点与 payload 字段。

## 验收
- 同一 canonical 候选卡选两次同一食物 → 第三次直接入库，卡片带习惯文案与「不是它？」。
- 点「不是它？」→ streak 清零 + 重弹候选卡；选择后 streak 重新累计。
- 撤销习惯直连记录 / modify 改食物 → streak 清零，下次恢复弹卡。
- 中途在候选卡选了别的食物 → streak 重置为 1，不误跳卡。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/LEARNING_SPEC.md §6 §7、docs/DATA_MODEL.md。只做任务 T30：user_food_alias 表 + resolve 时 upsert + streak≥2 跳候选卡 + record_card 逃生口（前端）+ undo/改食物联动清 streak + alias/reset 端点（更新 API_SPEC）。验收覆盖逃生口和撤销联动。

## 实现记录（非显而易见的坑）

- **逃生口必须删旧记录，不只是重置计数器**：任务描述"streak 清零并重发候选卡"容易读成只是个计数器操作，但如果不删掉那条误判的 `food_record`，用户重新选完食物后会同时存在"错的自动记录"+"新选的记录"两条，热量翻倍。`POST /api/learning/alias/reset` 实际做三件事：① 清零 streak（`updateMany`，不存在也不报错）② **删除**误判记录（类比 append 撤销）+ 记一条 `signal_type=delete` 学习事件 ③ 用同一份份量估算（`escape.portions`/`chosen_label`，不重新调 AI）重新走候选流程。delete 事件必须在 `foodRecord.delete` **之前**写入——同 T29 踩过的外键坑。
- **候选卡数据构建抽成 `buildCandidateCardData()`**（`services/intents/food-item.ts`），原来只有 `processFoodItem` 的歧义分支用，现在 reset 端点也复用，避免候选列表拼装逻辑抄两遍。
- **`portion_choice` pending 的 candidates 缺 `chosen_label`**：算"AI 预测份量"要有基准，改动 `food-item.ts` 生成候选/份量卡、以及 `pending.ts` 里 food_choice→portion_choice 两步转换时，都把 `chosen_label` 顺手带进 candidates（T29 已改，T30 复用）。
- **alias 命中判定必须在歧义检测和 `matchFoodCandidates` 调用之前**——不是简单加个 if，而是把 `food: FoodStandard | null` 提前声明，`if (!food) {...}` 包住原来的整段歧义判定+`matchFood`逻辑，两条路径（alias 命中 / 正常匹配）在此之后共用同一套 confidence/decision 流程。份量置信度（`portion_confidence`）依然独立生效——alias 只跳过"食物是什么"的判定，不跳过"份量对不对"的判定（"不越权"）。已用直接调用 `processFoodItem`（构造 `is_ambiguous:true`+低 `food_confidence` 的 item）验证：alias 命中会无视 AI 自己标的歧义/低置信，但份量置信度仍正常生效，会走 PortionCard 而非直接入库。
- **实测发现一个有意思的现象（非 bug，记录供以后参考）**：同一会话内连续两次提到同一模糊词（如"煎饼"），AI 在第二次解析时会因为 L0 最近对话上下文（刚记过"煎饼→煎饼果子"）**主动把 canonical 直接归一成"煎饼果子"**，而不是继续用"煎饼"——这是 AI_PARSING_SPEC 指代消解设计的正常行为，但导致 `streak` 累计的 key（canonical）在单次会话内漂移，不会稳定攒在同一个 canonical 上。这意味着 alias 机制在**跨会话/冷启动**场景（没有 L0 上下文可依赖，AI 每次都得重新问）价值最大，与 AI 自身的会话内指代消解是互补关系，不是竞争关系。因为这个特性，用真实 AI 对话很难在单次测试里稳定复现 streak≥2，验收改用直接调用 `processFoodItem`/`upsertFoodAlias`/`handleModify` 等函数 + 真实 HTTP 端点分别验证写入逻辑、读取(跳卡)逻辑、reset 端点、undo 联动、modify 联动——五条路径全部通过，且函数级验证比死磕 AI 会话更可靠。
- 前端 `RecordCard` 把"撤销"和"不是它？"复用同一个 `undoneCards[messageId]` 已处理态（不再要求 `undoInfo &&`），避免引入第二套状态机；据 `matched_by_habit` 决定"已撤销"还是"已替换"文案。
