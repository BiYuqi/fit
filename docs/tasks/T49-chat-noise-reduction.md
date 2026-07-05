# T49 — 聊天降噪：回执事件化 + 免确认删除 + "删除一个X"量词语义

**状态**：✅完成

**目标**：消灭聊天流里的操作噪音（2026-07-04 真机截图立项）。三件事：① 系统回执从全尺寸气泡降级为**居中小字事件行**（带撤销）；② 删除去掉确认卡，改为**直接删 + 可撤销**；③ 修解析 bug——"删除一个李子"（记录里有 2 个）应是**数量减一的 update**，不是整条 delete。

**背景**：T46–T48 把卡片收敛成一餐一卡后，聊天仍然乱。真机一屏 10 条消息里只有 1 条是内容：「已删除『梨』」「已修改，营养数据已更新」等回执与用户消息同权重占版面；一次删除要 4 条消息（用户说删 → 确认卡 → 点确认 → 已删除回执）；量词误解（删一个→删整条）逼用户重录再删，噪音翻倍。

**依赖**：T47/T48（meal_card 刷新链路与前端 upsert 已就位）
**关注文档**：DATA_MODEL（新 kind=event + payload 语义，本任务更新）、API_SPEC（删除响应/恢复接口，本任务更新）、AI_PARSING_SPEC §8（免确认删除 + 量词规则，本任务更新）、DESIGN_SPEC §3（事件行样式，本任务更新）

## 设计要点

### ① 回执事件行（kind=event）

- 新增 `chat_message.kind = "event"`：前端渲染为**居中一行小灰字**（视觉同时间分隔符量级，参考 Telegram "xxx 加入群组"），不是气泡。payload：
  ```json
  {
    "event_type": "deleted | modified",
    "text": "已删除 李子 · -38 kcal",        // 后端组装好的展示文案（铁律1：数字来自后端）
    "record_id": "...",
    "undo": { "prev_state": { ...被删记录完整快照... } },  // 可撤销时存在；撤销后清除
    "undone": false
  }
  ```
- **一次操作只产一条事件行**。modify.update/append 现有的「已修改，营养数据已更新：…」text 回复改为 event，文案带 delta：「已修改：李子 100g → 200g（+38 kcal）」。删除产「已删除 李子 · -38 kcal」。
- 事件行带内联「撤销」小按钮（payload.undo 存在且 undone=false 时显示）；撤销后该行变「已撤销」灰态。
- **历史回放兼容**：旧消息里的 `delete_confirm_card` / text 回执原样渲染，不迁移不删除（铁律 3：聊天记录是展示层）。
- meal_card 的项级撤销（T48 last_change）保留不动——事件行撤销与卡上撤销指向同一条 undo 链路，谁可见用谁。

### ② 免确认删除（直接删 + 可撤销）

- `modify.ts` delete 分支（`modify.ts:109`）：**不再创建** pendingRecord/delete_confirm_card，直接执行删除——复用 `pending-resolve.ts:49` delete_confirm 分支的完整逻辑，抽成共享函数 `executeDelete`：学习事件先写（FK 约束，删前插入）→ deleteMany → resolve 摘要进 L0（aiParseLog，T37 双向记忆）→ recompute → refreshMealCard（createIfMissing:false）→ 产出 event 消息。
- **撤销 = 恢复**：删除前把记录完整快照（food_id / weight_g / portion_label / meal_type / date / raw_input / is_estimated / scene / 营养字段 / calorie_override 等，运动记录同理）存进 event payload.undo.prev_state。新增 `POST /chat/events/:message_id/undo`（或扩展现有 undo 路由，实现时定，API_SPEC 同步）：按快照**重建记录**（新 id）→ recompute → refreshMealCard → 更新 event 消息 payload（undone:true、清 undo）→ 响应带 messages（刷新后的卡 + 更新后的事件行，同 T47 undo 模式）。
- 恢复产生的新记录不回填旧 learning_event（delete 信号保留，恢复不算新信号，LEARNING_SPEC 口径不变）。
- `pending-resolve.ts` 的 delete_confirm 分支**保留**（存量未 resolve 的 pending 还能点），只是不再有新增来源；前端 `delete-confirm-card.tsx` 保留用于历史回放。
- exercise 删除同样走直删 + event + 可恢复。

### ③ "删除一个X"量词语义（parser）

- `schema.ts` actionProp 描述（`schema.ts:147`）补规则：**用户只删部分数量时（"删掉一个/少一个/其实只吃了一个"），且上下文该记录份量大于要删的量 → action=update + change 填减量后的新份量，不是 delete**；只有明确删整条（"把李子删了/删掉那条"）才是 delete。上下文包 recent_records 已带份量，AI 有判断依据。
- AI_PARSING_SPEC §8 同步该规则。
- eval 新增案例（改 AI 相关代码，前后必跑全量 eval）：
  - 记"2个李子" → "删除一个李子" → 断言 intent=modify action=update，记录保留且份量/热量减半。
  - 记"2个李子" → "把李子删了" → 断言 action=delete，整条删除。

## 改动清单

- `backend/src/services/intents/modify.ts`：delete 直删（共享 executeDelete）+ event 产出；update/append 回复降级 event（delta 文案）。
- `backend/src/services/pending-resolve.ts`：delete_confirm 删除逻辑抽出为共享函数，分支本身保留（存量兼容）；**份量/候选确认落库后不再产「已确认：…」文本回执**（见补记④）。
- `backend/src/routes/`：event 撤销/恢复接口（重建记录）。
- `backend/src/ai/schema.ts`：action 描述补量词规则。
- `frontend/src/types/chat.ts`：event kind + payload 类型。
- `frontend/src/components/chat/`：新 `event-line.tsx`（居中小字 + 内联撤销）；`message-item.tsx` 接入。
- `frontend/src/stores/chat-store.ts`：event 撤销动作（调恢复接口，响应 upsert 合并，复用 T47 helper）。
- `backend/eval/cases/`：量词删除两案例；存量 delete_confirm 断言的案例改为断言直删 + event。
- `docs/DATA_MODEL.md`、`docs/API_SPEC.md`、`docs/AI_PARSING_SPEC.md §8`、`docs/DESIGN_SPEC.md §3`：同步。

## 验收

1. 记一餐两样 → "把鸡蛋删了" → **无确认卡**，一步到位：聊天流只多一条居中小字「已删除 鸡蛋 · -72 kcal · 撤销」，meal_card 原地少一项，daily_summary 已扣除。
2. 点事件行「撤销」→ 记录恢复（Today/History 数字回来），meal_card 恢复该项，事件行变「已撤销」灰态；再点无效（幂等）。
3. "米饭改成两碗" → 只出一条事件行「已修改：米饭 …→…（+xxx kcal）」，无"已修改，营养数据已更新"气泡，无新卡，卡片数据已更新。
4. 记"2个李子" → "删除一个李子" → 记录仍在、份量减半、热量减半（update 路径）；"把李子删了" → 整条删除（delete 路径）。
5. 历史消息：旧 delete_confirm_card / 旧 text 回执照常显示；存量未处理的确认卡仍可点确认/取消。
6. 运动记录删除同样免确认 + 可恢复。
7. `npm test`、`tsc` 前后端通过；全量 `npm run eval` 无回归（量词新案例通过）。

## 补记 ④ — 份量确认回执也降噪（2026-07-05 真机截图补立项）

**问题**：T49 只降级了 delete/modify 回执，漏了**份量/候选确认回执**。用户说模糊份量（"喝了2口安慕希酸奶"）→ 选份量卡 → 确认后仍产一条全尺寸白气泡「已确认：安慕希酸奶 20g（约 18 kcal）」。而下方 meal_card 已原地列出该项，这条回执纯冗余——和 T49 要消灭的是同一类噪音。

**决定**：直接**去掉这条文本回执**，不降级为事件行。理由：meal_card 原地 upsert 本身就是"已录入"的视觉反馈；份量是用户刚亲手选的，无删除那种撤销诉求，再补一条事件行仍是噪音。resolve 后聊天流只留刷新后的该餐卡。

**改动**：`pending-resolve.ts` 落库分支删除 `confirmMsg`（原 `已确认：…` text 消息），`messages` 从 `[confirmMsg]` 改为 `[]` 后交给 `refreshMealCard`。`refreshMealCard` 默认 `createIfMissing:true` 且记录刚落库，卡必然存在/新建，`messages` 稳定只含该餐卡，无空数组边界。

**兼容**：历史里旧的「已确认」气泡照常回放（铁律3，不迁移），只是不再新增。

**验收**：说模糊份量 → 选份量 → 聊天流只多刷新后的餐卡，无「已确认」气泡；`tsc` + `npm test`（132）通过；不碰解析，eval 断言的 intent/action 不受影响。
