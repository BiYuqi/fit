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
req（任意子集）：`{ name?, gender, age, height_cm, weight_kg, target_weight_kg, activity_level, goal_type?, daily_deficit?, custom_tdee?, is_review? }`
行为：保存并按 CALORIE_ENGINE 计算 bmr/tdee/targets，置 `onboarded=true`。体重变化时顺手 append `weight_log`（LEARNING_SPEC §8）。
`is_review`（可选 bool，控制位非档案列）：本次 PUT 来自设置页「重看引导」时前端置 `true`，后端据此**跳过 weight_log append**（重看不是称重，T51）；首次引导与设置页改体重不传，照常 append。
resp: 同 GET。

## 聊天主入口
### POST /api/chat/message
req: `{ text, source: "text"|"voice" }`
后端：判意图 → record（自动入库或生成 pending）/ query（用上下文卡回答）/ chat / modify（改/删/追加已记录，见 AI_PARSING_SPEC §8）/ discuss（针对某条记录提问，见 §9）/ resolve_pending（打字回答【待确认】卡片，见 §10）/ record_weight（上报实测体重，只 append weight_log 不改档案，见 §13）/ multi（一条消息多个动作，见 §12）。
> 每轮注入「对话记忆包」(L0/L1/L2，见 AI_PARSING_SPEC §7) 消解指代，记忆只取 ai_parse_log/事实表，不读 chat_message。
resp:
```json
{
  "intent": "record|query|chat|modify|discuss|resolve_pending|record_weight|multi",
  "reply": "已记录 牛肉面+鸡蛋，约 620 kcal",
  "record": { /* food_record，若高置信自动入库；modify.update / resolve_pending 返回落库或更新后的记录 */ },
  "pending": { "id": "...", "type": "portion_choice|food_choice|clarify", "candidates": [ ... ] },
  "summary_card": { /* 见 AI_PARSING_SPEC 上下文卡结构 */ },
  "messages": [ /* 本轮的 chat_message（用户气泡 + AI 卡片），供前端直接渲染并入本地缓存。T46 起可含已存在 id 的消息（meal_card 原地更新，created_at 已刷新）——语义 = 原地更新，前端须按 id upsert 并按 created_at 重排，不得当新消息追加 */ ],
  "resolved_pending_id": "...（仅 resolve_pending 命中时返回，前端据此把聊天流里那张旧卡就地标已确认）"
}
```
`record` 与 `pending` 互斥；query/chat 时二者均无。
modify 行为（AI_PARSING_SPEC §8；卡片语义 T47 起为 meal_card 原地刷新，回执语义 T49 起为居中事件行）：
- `delete` → **免确认直接执行**（T49，不再经 pending/delete_confirm_card）：messages 带一条 `event`（`event_type=deleted`，`payload.undo.prev_state` 是被删记录完整快照，供 `/api/chat/events/:id/undo` 撤销）+ 被刷新的该餐 meal_card（items 减一；全删光 → `items: []`）。量词减量（"删除一个 X"，该记录份量对应多份）判为 `update` 而非 `delete`，见 AI_PARSING_SPEC §8。
- `update` → 直接改 food_record + 重算，messages 带一条 `event`（`event_type=modified`，`payload.text` 是带 delta 的文案如"已修改：米饭 100g → 200g（+130 kcal）"，不带 `undo`）+ 该餐 meal_card（bump，`payload.last_change = { record_id, prev_state }`，撤销走这里）；改餐次是双卡刷新（旧餐卡少一项、新餐卡多一项，旧餐卡只刷已存在的）。
- `append` → 在 target 所属餐新增记录 + 重算，并入该餐 meal_card 并 bump，`last_change = { record_id }`（无 prev_state = 撤销即删除）；低置信走 portion/candidate 卡。

`event.payload`（T49）：
```json
{ "event_type": "deleted|modified", "text": "已删除 李子 · -38 kcal", "record_id": "...", "undo": { "prev_state": {...} }, "undone": false }
```
前端渲染为居中小字（非气泡），`undo` 存在且 `undone=false` 时带内联撤销按钮；`event_type=deleted` 撤销调 `/api/chat/events/:id/undo`，`event_type=modified` 没有 `undo`（撤销走该餐 meal_card 的 `last_change`）。存量 `delete_confirm_card`/纯文本回执按原样回放（不迁移）。

`meal_card.payload`（T46，一餐一卡）：落库只存 `{ meal_key: { date, meal_type }, last_change }`；接口返回时后端从 food_record 实时组装补上：
```json
{
  "meal_key": { "date": "2026-07-04", "meal_type": "lunch" },
  "last_change": { "record_id": "...", "prev_state": { /* 同 undo 接口 prev_state */ } },
  "items": [ { "record_id", "food_name", "count", "count_unit", "raw_input", "weight_g", "calories", "protein_g", "fat_g", "carbs_g", "is_estimated", "portion_label" } ],
  "totals": { "calories", "protein_g", "fat_g", "carbs_g" },
  "item_count": 3
}
```
明细主显示用 `food_name`（+ 有 `count` 时缀 `×count` 份数，如「韭菜鸡蛋包子 ×2」），`weight_g` 作副信息（如「（180g）」）；`count` 为空（纯重量记录/旧数据）时只显示 `food_name + weight_g`。`raw_input`（用户原话子句）不再作主显示，仅留作数据留痕。`items: []` 表示该餐记录已全删光（渲染"已清空"态）。内容变更时同一条消息 `created_at` 刷新（卡片跟随），POST 响应与 GET 都会返回其最新组装态。
`last_change`（T47）：该餐最近一次 modify 的撤销信息（单槽：再次修改覆盖、撤销后清除），有 `prev_state` = update 撤销（还原），无 = append 撤销（删除），T48 据此在展开态渲染对应项的撤销按钮，点按调 `/api/records/:id/undo`。

用户食物直连命中（LEARNING_SPEC §6 §7，T30）时不再有专门的「不是它？」按钮：直连纠错走自然语言改食物（modify.update `change.food`）或撤销该记录，两者都触发 alias streak 清零（见 LEARNING_SPEC §7）。

resolve_pending 行为（AI_PARSING_SPEC §10，T38）：用户打字回答【待确认】卡片（不点卡）时命中。内部复用 `/api/pending/:id/resolve` 同一套落地逻辑（份量卡/候选卡/删除确认三分支），返回其产出的卡片消息 + `resolved_pending_id`；无待确认或卡片已过期（>5分钟）时不落任何数据，只回一句提示文本。

### POST /api/pending/:id/resolve
req: `{ choice }`（选中的候选标识，或自定义克数 `{ grams }`；`delete_confirm` 传 `{ choice: "confirm" }`）
行为：据选择建 food_record / 删记录（delete_confirm）、刷新 daily_summary、补写对应 chat_message。
resp: `{ record?, summary_card, messages }`。落库确认时（T46）messages = 文本确认 + 该餐 meal_card（可能是已存在 id 的原地更新，见上）。
> `delete_confirm` 分支（T49 起）只服务存量未 resolve 的旧卡片；免确认删除不再产生新的 `pending(type=delete_confirm)`，见上方 modify.delete 行为与 `event`。

### POST /api/records/:id/undo
撤销 modify 的 update/append（见 AI_PARSING_SPEC §8），由 `meal_card.payload.last_change` 驱动。
req: `{ prev_state? }`——带 `prev_state{food_id,portion_label,weight_g,meal_type?,calories?,protein?,fat?,carbs?,calories_source?}` → 还原（update 撤销）；不带 → 删该记录（append 撤销）。
运动记录的 `prev_state` 形状是 `{kind:"exercise", calories_burned, duration_min?, user_reported?}`（T73：改时长后撤销要连时长和自报标记一起还原，只回滚热量会留下矛盾行；两个新字段 optional，兼容 T73 之前发出的老卡片）。
`calories/protein/fat/carbs/calories_source`（T40）若齐全，直接还原这些精确值，不按 food×grams 重算——`change.calories`（用户真值覆盖）产生的记录，重算值会不同于落库值，必须精确还原。
行为：还原/删记录后重算 daily_summary；若该记录 `alias_canonical` 非空，联动清零对应用户食物直连的 streak（见 LEARNING_SPEC §7）。
resp: `{ ok, summary_card, messages }`（T47 新增 messages）——受影响餐次刷新后的 meal_card（改餐次撤销为双卡；只刷已存在的卡，`last_change` 已清除；运动撤销 `messages: []`），前端按 id upsert + created_at 重排。

### POST /api/chat/events/:message_id/undo（T49）
撤销 modify 的 delete 免确认删除。message_id 是那条 `kind=event`（`event_type=deleted`）的 chat_message id；prev_state 从该消息自身的 `payload.undo.prev_state` 读取，请求体为空。
行为：按快照重建记录（**新 id**，食物/运动记录同理）→ 重算 daily_summary → 食物记录额外刷新受影响的该餐 meal_card → 更新事件消息 `payload`（`undone: true`，清 `undo`）。恢复不产生新的 learning_event（delete 信号保留，恢复不算新信号）。幂等：`payload.undone` 已为 `true` 时直接返回当前状态，不重复重建。
resp: `{ ok, summary_card, messages }`——`messages` 含更新后的事件消息（+ 食物场景下刷新的 meal_card），前端按 id upsert。

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
resp: `{ dates: ["YYYY-MM-DD", ...] }`（升序），有对话的日期列表。
> 既供线程选择器，也是**上翻分页的路标**：前端按这份列表一次翻 N 个「有聊天的日期」，中间的空档整段跳过。前端取的窗口 = 服务端保留期（365 天）。

### GET /api/chat/search?q=&limit=（默认 50，上限 100）
resp: `{ messages: chat_message[] }`，只含 `kind=text`，按 `date desc, created_at desc`。
> 全量历史搜索。本地 SQLite 只镜像最近 90 天，新设备刚登录时更是空的，纯本地 LIKE 搜不到早期对话；前端断网时才退回本地缓存搜索。
