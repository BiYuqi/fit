# T30 — 用户食物直连（P2：记住"他的煎饼=煎饼果子"，跳候选卡）

**状态**：⬜待办

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
