# API_SPEC — 接口契约

> 前后端**唯一对齐源**。字段语义见 DATA_MODEL（此处不重定义）。

## 约定
- Base：`/api`。除注册/登录外均需 `Authorization: Bearer <JWT>`。
- 请求/响应均为 JSON。日期用 `YYYY-MM-DD`。
- 错误格式：`{ "error": { "code": string, "message": string } }`，HTTP 4xx/5xx。
- 后端用 zod 校验入参；DeepSeek 返回也用 zod 校验（见 AI_PARSING_SPEC）。

## 认证
### POST /api/auth/register
req: `{ account, password }` → resp: `{ token }`
account 已存在 → 409 `account_taken`。

### POST /api/auth/login
req: `{ account, password }` → resp: `{ token }`，凭据错误 → 401。

## 用户 / Onboarding
### GET /api/user/profile
resp: users 全字段 + 计算出的 `{ bmr, tdee, target_calories, target_protein }`。

### PUT /api/user/profile
req（任意子集）：`{ name?, gender, age, height_cm, weight_kg, target_weight_kg, activity_level, goal_type?, daily_deficit? }`
行为：保存并按 CALORIE_ENGINE 计算 bmr/tdee/targets，置 `onboarded=true`。
resp: 同 GET。

## 聊天主入口
### POST /api/chat/message
req: `{ text, source: "text"|"voice" }`
后端：判意图 → record（自动入库或生成 pending）/ query（用上下文卡回答）/ chat / modify（改/删/追加已记录，见 AI_PARSING_SPEC §8）/ discuss（针对某条记录提问，见 §9）/ resolve_pending（打字回答【待确认】卡片，见 §10）。
> 每轮注入「对话记忆包」(L0/L1/L2，见 AI_PARSING_SPEC §7) 消解指代，记忆只取 ai_parse_log/事实表，不读 chat_message。
resp:
```json
{
  "intent": "record|query|chat|modify|discuss|resolve_pending",
  "reply": "已记录 牛肉面+鸡蛋，约 620 kcal",
  "record": { /* food_record，若高置信自动入库；modify.update / resolve_pending 返回落库或更新后的记录 */ },
  "pending": { "id": "...", "type": "portion_choice|food_choice|clarify|delete_confirm", "candidates": [ ... ] },
  "summary_card": { /* 见 AI_PARSING_SPEC 上下文卡结构 */ },
  "messages": [ /* 本轮新增的 chat_message（用户气泡 + AI 卡片），供前端直接渲染并入本地缓存 */ ],
  "resolved_pending_id": "...（仅 resolve_pending 命中时返回，前端据此把聊天流里那张旧卡就地标已确认）"
}
```
`record` 与 `pending` 互斥；query/chat 时二者均无。
modify 行为（AI_PARSING_SPEC §8）：
- `delete` → 返回 `pending(type=delete_confirm)` + `delete_confirm_card`，**需用户确认**后才删（走 resolve）。
- `update` → 直接改 food_record + 重算，返回 `record_card`，其 `payload.undo = { record_id, prev_state }`。
- `append` → 在 target 所属餐新增记录 + 重算，`record_card` 的 `payload.undo = { record_id }`（高置信）；低置信走 portion/candidate 卡。

`record_card.payload` 基础字段：`{ food_name, weight_g, unit, calories, protein_g, fat_g, carbs_g, is_estimated, meal_type }`。`meal_type` 为该记录餐次（breakfast/lunch/dinner/snack），前端卡片据此显示"午餐 · 80g"；历史消息可能缺失，缺失时前端不显示餐次（不得兜底成某个具体餐次）。

用户食物直连命中时（LEARNING_SPEC §6 §7，T30），`record_card.payload` 额外带：
```json
{ "matched_by_habit": true, "escape": { "canonical", "portions", "chosen_label", "ai_candidates?" } }
```
前端据此显示"已按你的习惯记为「X」"+「不是它？」按钮；点击时把 `escape` 的字段连同 `canonical`/`record_id` 传给 `/api/learning/alias/reset`（见下）。

resolve_pending 行为（AI_PARSING_SPEC §10，T38）：用户打字回答【待确认】卡片（不点卡）时命中。内部复用 `/api/pending/:id/resolve` 同一套落地逻辑（份量卡/候选卡/删除确认三分支），返回其产出的卡片消息 + `resolved_pending_id`；无待确认或卡片已过期（>5分钟）时不落任何数据，只回一句提示文本。

### POST /api/pending/:id/resolve
req: `{ choice }`（选中的候选标识，或自定义克数 `{ grams }`；`delete_confirm` 传 `{ choice: "confirm" }`）
行为：据选择建 food_record / 删记录（delete_confirm）、刷新 daily_summary、补写对应 chat_message。
resp: `{ record?, summary_card, messages }`。

### POST /api/records/:id/undo
撤销 modify 的 update/append（见 AI_PARSING_SPEC §8），由 `record_card.payload.undo` 驱动。
req: `{ prev_state? }`——带 `prev_state{food_id,portion_label,weight_g}` → 还原（update 撤销）；不带 → 删该记录（append 撤销）。
行为：还原/删记录后重算 daily_summary；若该记录 `alias_canonical` 非空，联动清零对应用户食物直连的 streak（见 LEARNING_SPEC §7）。resp: `{ ok, summary_card }`。

### POST /api/learning/alias/reset
「不是它？」逃生口（见 LEARNING_SPEC §6 §7）。用户食物直连（streak≥2）自动匹配错了时调用。
req: `{ canonical, record_id, portions, chosen_label, ai_candidates? }`——`portions`/`chosen_label`/`ai_candidates` 取自触发本次逃生口的 `record_card.payload.escape`（见下）。
行为：清零该 canonical 的 alias streak → 删除该条误判记录（记一条 `signal_type=delete` 学习事件，只记不训练）→ 用同一份份量估算重新走候选流程，产出新的 `candidate_card`。
resp: `{ summary_card, messages: [candidate_card 消息] }`。

## 数据查询（读事实层）
### GET /api/daily/today
resp: `{ summary: daily_summary, records: food_record[], exercises: exercise_record[] }`。

### GET /api/daily/range?from=&to=&granularity=day|week|month
resp: 聚合数组，每项 `{ period, calories_in, total_out, deficit, protein, fat, carbs }`。

## 聊天记录（读展示层）
### GET /api/chat/messages?date=YYYY-MM-DD
resp: `{ date, messages: chat_message[] }`，按 created_at 升序。
> 用于按日期加载对话线程（顶部"今天 ▼"切换）。前端先读本地 SQLite 再用此接口同步。

### GET /api/chat/messages/range?from=YYYY-MM-DD&to=YYYY-MM-DD
resp: `{ messages: chat_message[], resolved_pending_ids: string[] }`，按 created_at 升序。
> 全量读取日期范围内的消息，供前端数据本地化（SQLite 全量缓存 → FlatList 连续渲染 + 搜索纯内存过滤）。
> 包含 `resolved_pending_ids`（和单日查询逻辑一致）供前端隐藏已处理的 pending 卡。

### GET /api/chat/dates?from=&to=
resp: `{ dates: ["YYYY-MM-DD", ...] }`，有对话的日期列表，供线程选择器。
