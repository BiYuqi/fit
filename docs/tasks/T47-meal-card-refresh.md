# T47 — 餐食卡原地刷新：modify/删除/撤销全路径 + 前端按 id upsert（P3 同餐食物分组）

**状态**：✅完成（2026-07-04）

**目标**：自然语言修改后**不再生成新卡**：modify update/append、删除确认、撤销，全部落到"数据更新 → 该餐 meal_card bump 刷新 → 文本回复『已修改，营养数据已更新』"。前端消息合并逻辑从"已存在 id 跳过"改为**按 id upsert + 按 created_at 重排序**——这是原地更新与卡片跟随能生效的关键。

**依赖**：T46（meal_card 生成与实时组装已就位）
**关注文档**：API_SPEC（undo 响应变化，本任务更新）、AI_PARSING_SPEC §8（modify 卡片行为描述同步）、DATA_MODEL（payload.last_change 语义，本任务更新）

## 设计要点

- **modify.update**（`modify.ts:244` 现在生成新 record_card）：数据更新逻辑一行不动；卡片改为对受影响餐次调 `upsertMealCardMessage`（bump），并把撤销信息写进落库 payload：
  ```json
  "last_change": { "record_id": "...", "prev_state": { ...同现有 undo prev_state... } }
  ```
  enrichment 保留 last_change 透传给前端——展开态中该项显示撤销按钮（T48 渲染）。再次修改覆盖 last_change；撤销后清除。回复文本统一为「已修改，营养数据已更新。」（可带简短说明，如改了什么）。
- **改餐次是双卡刷新**：`change.meal_type`（含批量改餐次 `modify.ts:26`）涉及**旧餐次卡与新餐次卡两张**，都要 bump（旧卡少一项、新卡多一项）。
- **modify.append**：processItems 复用路径（T46 已去掉 confirmedFn），append 后对目标餐次 upsert + `last_change: { record_id }`（无 prev_state = 撤销即删除，同现有 append 撤销语义）。
- **删除确认**（`pending-resolve.ts` delete_confirm 分支）：删除后刷新该餐 meal_card 并随 messages 返回；items 减到 0 时卡片自然进"已清空"态（enrichment items:[] 承载，无需额外状态字段）。
- **undo 接口**（`records.ts` /api/records/:id/undo）：撤销后刷新对应餐次 meal_card（改餐次撤销同样双卡）、清除 payload.last_change，响应**新增 `messages` 字段**返回刷新后的卡（API_SPEC 同步）。运动撤销不涉及 meal_card。
- **前端 chat-store**（`chat-store.ts` sendMessage:246 / resolve / undo 三处响应处理）：统一抽一个合并 helper——**按 id upsert（存在则整条替换）+ 按 created_at 稳定重排序**；删除现有 `existingIds` 跳过逻辑。本地 SQLite `upsertMessages` 已按 id upsert，确认排序读取口径一致即可。
- **跨天修改**：改昨天的记录 → 刷新的是昨天那张卡（chat_message.date 不变，created_at bump 到昨天消息流末尾）；今天的聊天窗口只见文本回复，不做特殊处理（回复文案已说明结果）。
- **multi（T45）**：ops 循环复用单意图 handler，天然继承；同一条消息多个 op 触发同一张卡多次 bump 无害（幂等）。

## 改动清单

- `backend/src/services/intents/modify.ts`：update / append / 批量改餐次三条路径接 meal_card 刷新，去掉新建 record_card；回复文案。
- `backend/src/services/pending-resolve.ts`：delete_confirm 分支返回刷新卡。
- `backend/src/routes/records.ts`：undo 后刷新 + 响应加 messages + 清 last_change。
- `backend/src/services/meal-card.ts`：upsertMealCardMessage 支持写入/清除 last_change。
- `frontend/src/stores/chat-store.ts`：合并 helper（upsert by id + 重排序），sendMessage / resolve / undo 三处接入。
- `backend/eval/cases/`：涉及 modify 卡片断言的用例更新（multi-action 等）。
- `docs/API_SPEC.md`、`docs/DATA_MODEL.md`、`docs/AI_PARSING_SPEC.md §8`：同步。

## 验收

1. 记一餐三样 → "米饭改成两碗" → 无新卡；同 id meal_card 数据更新且浮到聊天流末尾；文本回复"已修改，营养数据已更新"；daily_summary 已重算。
2. "把鸡蛋删了" → 删除确认卡 → 确认后 meal_card items 减一并 bump；全删光 → items:[]。
3. "鸡蛋是早餐吃的"（改餐次）→ 午餐卡少一项、早餐卡多一项，两张卡都刷新浮起。
4. 改克数后走 undo 接口 → 记录还原 prev_state，响应带刷新卡，last_change 已清除。
5. 前端：聊天流中旧位置不残留重复卡；乱序响应（bump 后 created_at 变化）重排正确；SQLite 缓存重启后顺序一致。
6. `npm test`、`tsc`、全量 `npm run eval` 无新回归。
