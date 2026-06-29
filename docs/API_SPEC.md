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
后端：判意图 → record（自动入库或生成 pending）/ query（用上下文卡回答）/ chat。
resp:
```json
{
  "intent": "record|query|chat",
  "reply": "已记录 牛肉面+鸡蛋，约 620 kcal",
  "record": { /* food_record，若高置信自动入库 */ },
  "pending": { "id": "...", "type": "portion_choice|food_choice|clarify", "candidates": [ ... ] },
  "summary_card": { /* 见 AI_PARSING_SPEC 上下文卡结构 */ },
  "messages": [ /* 本轮新增的 chat_message（用户气泡 + AI 卡片），供前端直接渲染并入本地缓存 */ ]
}
```
`record` 与 `pending` 互斥；query/chat 时二者均无。

### POST /api/pending/:id/resolve
req: `{ choice }`（选中的候选标识，或自定义克数 `{ grams }`）
行为：据选择建 food_record、刷新 daily_summary、补写对应 chat_message。
resp: `{ record, summary_card, messages }`。

## 数据查询（读事实层）
### GET /api/daily/today
resp: `{ summary: daily_summary, records: food_record[], exercises: exercise_record[] }`。

### GET /api/daily/range?from=&to=&granularity=day|week|month
resp: 聚合数组，每项 `{ period, calories_in, total_out, deficit, protein, fat, carbs }`。

## 聊天记录（读展示层）
### GET /api/chat/messages?date=YYYY-MM-DD
resp: `{ date, messages: chat_message[] }`，按 created_at 升序。
> 用于按日期加载对话线程（顶部"今天 ▼"切换）。前端先读本地 SQLite 再用此接口同步。

### GET /api/chat/dates?from=&to=
resp: `{ dates: ["YYYY-MM-DD", ...] }`，有对话的日期列表，供线程选择器。
