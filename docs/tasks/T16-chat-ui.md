# T16 — Chat 页（核心）

**状态**：✅ 完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->
> 重开过一次：T23 给 modify 加了新卡片（delete_confirm_card）与撤销机制，前端补齐并真机点测通过（含撤销按卡片粒度、不再一损俱损）。

**目标**：消息流 + 各类卡片 + 输入 + 聊天持久化展示。
**依赖**：T11 T12 T14　**关注文档**：DESIGN_SPEC §3，API_SPEC 聊天


## 设计接入（视觉事实源）
用 claude_design MCP 导入设计的 **Chat 屏**做像素参照，在 RN 重建，**不要套用 .dc.html**。
- MCP：`https://api.anthropic.com/v1/design/mcp`（auth via `/design-login`）
- 项目：`https://claude.ai/design/p/7937f4c7-b628-4bbd-9801-f3855f803107?file=AI+%E5%87%8F%E8%84%82%E8%AE%B0%E5%BD%95+App.dc.html`

## 做什么
- 消息流渲染各 kind：用户气泡/record_card/portion_card/candidate_card/clarify_card/query_card/exercise_card/**delete_confirm_card**；底部输入栏(+附件/输入/语音占位/发送)。
- 接 /chat/message 与 /pending/:id/resolve；中低置信出卡，点选后替换为 record_card。
- **modify 接入（T23 后端，DESIGN_SPEC §3）**：
  - `delete_confirm_card`：出「确认删除「X」？」卡，确认→`/pending/:id/resolve {choice:"confirm"}`，取消→消卡。
  - record_card 带 `payload.undo` 时显示「撤销」按钮 → `/records/:id/undo`（带 prev_state 还原 / 不带删除），撤销后卡片置「已撤销」。
- 持久化：先读本地 SQLite 秒显，再 /chat/messages?date= 同步；顶部"今天▼"线程选择器用 /chat/dates。
- 卡片新鲜度：查询卡冻结；记录卡绑 record_id 实时回填/“已删除”。
- 空状态友好引导。

## 验收
- 打字记一餐→出 record_card；含糊输入→出选择卡，点选后入库并替换为确认卡。
- 切到 Today 再回，聊天与卡片仍在；切换日期加载对应线程。
- **「删了牛肉面」→ 出确认卡，点确认后删除并出「已删除」，点取消则消卡；不再是空白气泡。**
- **「牛肉面换大份」/「再加个蛋」→ record_card 上有「撤销」，点击后还原/删除并置「已撤销」，汇总同步回退。**

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/DESIGN_SPEC.md §3、docs/API_SPEC.md。用 claude_design MCP 导入设计的 Chat 屏做像素参照。只做任务 T16：在 Expo RN 实现 Chat 页(各类消息卡片+输入栏+pending 选择+本地缓存优先持久化+日期线程切换+卡片新鲜度)。视觉匹配设计的配色/间距/圆角/毛玻璃，浅深两套，RN 重建不套 .dc.html。
