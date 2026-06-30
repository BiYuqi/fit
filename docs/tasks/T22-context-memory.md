# T22 — 对话记忆包：L0/L1/L2 注入 prompt（让对话不丢上下文）

**状态**：✅完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：每轮把三层记忆拼进 DeepSeek 请求，解决指代与上下文丢失（「那个」「再来一碗」），让 AI 不显得愚蠢。这是「变聪明」的核心，**独立可验收**。
**依赖**：T04 T10 T11（需 ai_parse_log / daily_summary / chat 编排已在）　**关注文档**：AI_PARSING_SPEC §6–7，DATA_MODEL ai_parse_log/food_record/users

## 做什么
- 后端组装「对话记忆包」(AI_PARSING_SPEC §7) 并注入 parser/chat 的 prompt：
  - **L2 画像**：`user_profile`(users) + 上下文卡(§6，已有)，永久在场。
  - **L1 工作记忆**：`recent_records` = 今天全部 food_record/exercise_record 的当前值快照 + `ref`。
  - **L0 对话窗口**：`recent_turns` = 从 `ai_parse_log`(+join food_record) 抽最近 6~8 轮「用户话 + AI 动作锚点」结构化摘要，**去卡片 payload、去闲聊长文本**，滑动窗口。
- **铁律 3**：对话记忆**不从 chat_message 取**，只从 ai_parse_log / 事实表取。
- AI 仍不算账。

## 验收
- 「早餐吃了牛肉面」后说「再来一碗」→ AI 据 L0/L1 正确理解为同食物/同餐续记，不当成无关新词。
- 「蛋白质够吗」→ query 用 L2 上下文卡答得出（含剩余额度）。
- 抽查实际拼装的 prompt：`recent_turns` 不含卡片 payload、不含闲聊长文本；L0 仅 6~8 轮（滑动）。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/AI_PARSING_SPEC.md §6–7、docs/DATA_MODEL.md。只做任务 T22：后端组装 L0(ai_parse_log 摘要,滑动窗口6~8轮)/L1(今天 records 快照)/L2(画像+上下文卡) 记忆包并注入 DeepSeek prompt。严守铁律 3：不读 chat_message。用「牛肉面→再来一碗」「蛋白质够吗」验证上下文接续。不要做 modify(改/删/追加)，那是 T23。
