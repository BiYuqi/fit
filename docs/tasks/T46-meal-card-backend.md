# T46 — 餐食卡后端：一餐一卡 + 实时组装 + 卡片跟随（P3 同餐食物分组）

**状态**：⬜待办

**目标**：终结"一餐五个菜 = 五张卡刷屏"。新增 `meal_card` 卡片类型，按 **(用户, 日期, 餐次)** 一餐一卡：record/resolve 入库不再逐食材发 `record_card`，而是把食材并入当日该餐的 meal_card；卡片明细与营养总计**读取时从 `food_record` 实时组装**（永不过期）；内容变更时卡片 **created_at 刷新浮到聊天流末尾**（卡片跟随，解决淹没）。

**依赖**：T45（现状基线：record/modify/multi 全链路已定型）
**关注文档**：DATA_MODEL（chat_message.kind 与卡片显示策略，本任务更新）、API_SPEC（/chat/message 响应语义，本任务更新）、AI_PARSING_SPEC §8（卡片行为提及处同步）、FEATURE_CANDIDATES §P3（立项背景）

## 背景（2026-07-04 决策）

P3 曾因"合并成一张卡后撤销/修改怎么表达"搁置。现方案解开：**修改全部走自然语言（现有 modify 意图），卡片只负责原地刷新**。三个已拍板决策：
1. **单食材也统一用 meal_card**（只有一种饮食卡形态，续报"还有粽子"直接在同卡长出第二项）；
2. **展开态每项保留撤销**（T47/T48 落地，modify 的 undo 能力不因卡片合并丢失）；
3. **分组 = 日期 + 餐次**（与 food_record / Today 页口径一致），淹没问题由**卡片跟随**独立解决：内容每次变更（新增食材/修改/删除/撤销），同一条 chat_message 的 created_at 刷成当前时间，前端重排序后卡片"浮"到最新位置——不是新消息，聊天流里一餐永远只有一张卡，但永远在眼前。加餐一天多次也合一张卡，跟随机制让它成为"跟着你走的今日加餐流水卡"。

## 设计要点

- **落库 payload 只存组装键，不存明细快照**（贴合铁律 2/3：事实源是 food_record，卡片纯展示）：
  ```json
  { "meal_key": { "date": "2026-07-04", "meal_type": "lunch" }, "last_change": null }
  ```
  `meal_key.date` 与 chat_message.date 独立存（跨天修改时餐归属日 ≠ 对话日）。`last_change` 本任务恒 null，T47 启用（modify 撤销信息）。
- **新服务 `backend/src/services/meal-card.ts`**：
  - `upsertMealCardMessage(user_id, mealDate, meal_type)`：按 jsonb 路径查该餐已有 meal_card 消息（Prisma `payload: { path: [...], equals: ... }`）——有则 `update({ created_at: new Date() })`（bump），无则 create。返回消息行。**幂等**：同餐任意次调用只存在一条消息。
  - `enrichMealCards(messages)`：批量把 meal_card 的返回态 payload 组装完整：查 `food_record`（include food，where user_id + date + meal_type，orderBy created_at）→ `items[]`（record_id / food_name / **raw_input** / weight_g / calories / protein_g / fat_g / carbs_g / is_estimated / portion_label）+ `totals`（后端求和，铁律 1 合规）+ `item_count`。**组装结果不落库**，仅在响应/GET 时覆盖 payload。items 为空（全删光）返回 `items: []`，前端渲染"已清空"态。
  - 明细主显示用 `raw_input`（用户原话子句，如"全麦面包2片"，自然单位天然保留），`food_name + weight_g` 作兜底/副信息（raw_input 为空或经 modify 改食物后原话失真时用）——2026-07-04 与用户确认的显示方案，不给 food_record 加 unit 字段。
- **首次引导提示**：用户**第一张** meal_card 生成时（查该用户有无历史 meal_card 消息），record 回复文本追加一句"直接说就能修改、新增、删除食材"；之后不再出现。提示不常驻卡片上（每张都带就成了新的杂乱）。
- **record 路径改造**（`record.ts` + `food-item.ts`）：`processFoodItem` 高置信入库分支不再返回 record_card 的 `confirmedFn`，只返回 record；卡片生成上移到 `handleRecord`——processItems 结束后对本轮涉及的餐次调一次 `upsertMealCardMessage`，enrich 后放入 messages。歧义/份量卡的 `pendingFn` 照旧（疑问确认仍是独立消息）。**exercise_card 不动**（运动不属于"餐"）。注意 `processItems` 也被 modify.append 复用——本任务先保证 record 路径，append 路径 T47 统一接。
- **resolve 路径改造**（`pending-resolve.ts:282` 落库后的 record_card）：改为 upsertMealCardMessage + enrich 返回。
- **消息时序**：先创建文本回复类消息，后 bump 卡片——保证卡片排在本轮回复之后、聊天流最末。
- **读取接口**（`chat-history.ts`）：GET messages / messages/range 在 `enrichResolved` 之后串 `enrichMealCards`。
- **兼容**：历史 record_card 消息不迁移、照旧渲染；前端未认识 meal_card 前（T48 之前）会忽略未知 kind，不阻塞本任务验收（后端用 curl 自测）。
- **L0/记忆零改动**：记忆包读 ai_parse_log / food_record，不读 chat_message，卡片形态变化不影响 AI 上下文。parser 协议零改动。

## 改动清单

- `backend/src/services/meal-card.ts`：新建（upsertMealCardMessage + enrichMealCards + 单测）。
- `backend/src/services/intents/food-item.ts`：高置信分支去掉 record_card confirmedFn（ItemResult 精简）。
- `backend/src/services/intents/record.ts`：processItems 后统一挂 meal_card；回复文案维持"已记录：…"。
- `backend/src/services/pending-resolve.ts`：portion_choice 落库后的 record_card → meal_card upsert。
- `backend/src/routes/chat-history.ts`：两个 GET 接 enrichMealCards。
- `backend/src/routes/chat.ts`：POST 响应 messages 中的 meal_card enrich 后返回。
- `backend/eval/`：断言中 record_card 的期望更新为 meal_card，全量回归。
- `docs/DATA_MODEL.md`：chat_message.kind 加 meal_card；卡片显示策略段补"meal_card 实时组装 + created_at 跟随"。
- `docs/API_SPEC.md`：响应 messages 可含**已存在 id 的消息**（语义 = 原地更新，前端须按 id upsert）。

## 验收

1. curl 发"午餐吃了米饭、鸡胸肉、西兰花"→ 响应 messages 恰一张 meal_card，items=3，totals = 三条 food_record 之和；`food_record` 仍是 3 行独立记录（Today 页口径不变）。
2. 再发"还有一个鸡蛋"（续报继承餐次）→ **无新卡消息**：响应返回同 id meal_card，created_at 已更新，items=4。
3. GET /api/chat/messages → meal_card payload 为实时明细；手工删一条 food_record 后再 GET，items 自动少一项（不需任何回填写路径）。
4. 歧义食材（如"煎饼"）→ 候选卡照常独立出现，meal_card 只含已确认项；/pending/:id/resolve 走完两步后 items +1、卡片 bump。
5. 单测：upsertMealCardMessage 幂等（同餐两次返回同一消息 id）；enrichMealCards 求和正确、空餐返回 items:[]。
6. `npm test` 全绿、`tsc` 零错误、全量 `npm run eval` 无新回归（改 AI 链路前后必跑）。
