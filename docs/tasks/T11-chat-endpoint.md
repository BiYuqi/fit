# T11 — /chat/message + /pending/resolve + 聊天落库

**状态**：✅ 完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：聊天主入口编排，并把对话写入 chat_message。
**依赖**：T05 T10　**关注文档**：API_SPEC 聊天，AI_PARSING_SPEC，DATA_MODEL chat_message

## 做什么
- `POST /api/chat/message`：判意图→ record(高置信入库 / 中低置信建 pending) | query(用上下文卡答) | chat。返回 reply/record?/pending?/summary_card/messages。
- 写 chat_message：用户气泡 + AI 卡片(对应 kind)；记录类卡片带 record_id。
- `POST /api/pending/:id/resolve`：据 choice 建 food_record→刷新 summary→补写 chat_message。
- **AI 不算账**：热量一律走 calc。**Today/History 不读 chat_message。**

## 验收
- 记录一餐入库并返回 record_card；含糊输入返回 pending 且前端可据此出卡；resolve 后正确入库。
- query "还能吃多少" 用上下文卡答得出。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/API_SPEC.md、docs/AI_PARSING_SPEC.md。只做任务 T11：实现 /chat/message 与 /pending/:id/resolve，编排意图分流并写 chat_message(展示层)，热量只由 calc 算。用 curl 验证 record/pending/resolve/query 四条路径。
