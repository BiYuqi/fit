# T23 — modify 指代修改：update / delete / append + 确认卡 + 撤销

**状态**：✅完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：让用户能改/删/追加已记录的食物（「换大份」「删了」「再加个蛋」），按破坏性分级处理，不打扰过头。
**依赖**：T22 T05 T06 T11（需记忆包提供 target、匹配/计算引擎、chat 编排）　**关注文档**：AI_PARSING_SPEC §8，DATA_MODEL pending_record/chat_message

## 做什么
- AI 协议加 `modify` 意图（`action`: update/delete/append + `target` + `change`/`items`），更新 strict tool schema + zod（AI_PARSING_SPEC §2/§8）。`target` 引用 §7 `recent_records.ref`。
- 后端执行（路由见 §8 表）：
  - **delete** → 建 `pending_record(type=delete_confirm)` → 出确认卡(kind=`delete_confirm_card`) → `/pending/:id/resolve` 删记录 → 刷新 daily_summary。
  - **update 高置信** → 直接改 food_record + 重算，record_card `payload.undo` 带 `{record_id, prev_state}`。
  - **append 高置信** → 在 target 所属餐新增记录（走匹配+份量）+ 重算，卡带 `undo{record_id}`。
  - **update/append 低置信或歧义** → 走现成 portion_card/candidate_card，不新增卡。
- 撤销接口：还原 prev_state（update）/ 删新记录（append），短时间窗，不进 pending 流程。
- **AI 不算账**；重算一律 calc；**Today/History 不读 chat**。

## 验收
- 「牛肉面换大份」→ 直接改+重算，卡可撤销，撤销后恢复中份。
- 「早餐再加个蛋」→ 新增 breakfast 一条蛋记录，汇总更新。
- 「把那个蛋删了」→ 出确认卡，确认后删除并刷新汇总。
- 含糊「那个改一下」低置信 → 走份量/候选卡，不误删误改。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/AI_PARSING_SPEC.md §8、docs/DATA_MODEL.md。只做任务 T23：实现 modify 意图(update/delete/append)。delete 走 delete_confirm 确认卡+resolve；update/append 高置信直执行+undo；低置信走现成卡。target 用 T22 记忆包的 ref。热量只由 calc 重算。用「换大份/再加个蛋/删了那个」三条验证，并测低置信不误改。
