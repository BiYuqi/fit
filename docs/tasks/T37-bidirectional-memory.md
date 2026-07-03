# T37 — 对话双向记忆：reply_summary 回填 + 卡片动作进 L0（对话智能）

**状态**：⬜待办

**目标**：让 AI 记得**自己说过什么、做过什么**。这是 2026-07-03 体检认定的"觉得笨"最大病因。
**依赖**：T22 T28（记忆包 + intents 拆分已完成）　**关注文档**：AI_PARSING_SPEC §7、DATA_MODEL（ai_parse_log）

## 背景（为什么会有这个任务）

L0 对话窗口（memory.ts `TurnSummary`）只存 `{用户原话, 意图, 动作锚点}`，**AI 的回复内容一个字不进记忆**。典型翻车：

> 用户："蛋白质还差多少？" → AI："还差 35g，建议来份鸡胸肉" → 用户："行，来一份"
> → parser 不知道自己刚推荐过鸡胸肉，"来一份"指代消解失败。

同病：用户**点卡片**做的选择（候选卡选了"煎饼果子"、份量卡选了中份）不写 `ai_parse_log`，下一轮 L0 里这个动作是空白，"再来一份"无从指代。

**不违反铁律 3**：铁律禁的是读 `chat_message`（展示层）；本任务把回复摘要存进 `ai_parse_log`（AI 层事实），来源合规。

## 做什么（指引，不限定实现细节）

- **迁移**：`ai_parse_log` 加可空列 `reply_summary`（text）。DATA_MODEL.md 同步补字段语义。
- **回填**：chat.ts / intents 各 handler 在生成回复后回填本轮 parse log 的 reply_summary：
  - record/modify：回复模板文本本身已是摘要（"已记录：牛肉面 450g…"），直接存（可截断 ~150 字）；
  - chat/query/discuss：存回复全文截断（~150 字）。不额外调一次 AI 做摘要（成本不值）。
- **卡片动作**：`/pending/:id/resolve` 各分支写一条 ai_parse_log（如 input_text=`[点选卡片]`，intent=`resolve`，parsed_json 带 `{food_name, portion_label, grams}`，reply_summary=`确认：煎饼果子 中份 450g`），让卡片选择成为 L0 的一轮。
- **渲染**：`TurnSummary` 加 `reply` 字段；compressContext 的【最近对话】每轮渲染为两行或一行双段：`用户:"…" → 记录(…)；AI:"…"`（注意去噪：reply 已是摘要，不放卡片 payload）。
- **上下文预算护栏**（本任务顺手修的既有漏洞）：L0 渲染 `said`（用户原话）现状**无截断**，而单条消息上限 2000 字——长语音转文字会把 L0 撑爆。渲染时 said 截断 ~60 字、reply 截断 ~150 字（截断加"…"）；窗口维持"取 8 渲染 5"不变。原则：**上下文靠分层衰减控量（近的原始、远的聚合），不靠拉长窗口**。
- AI_PARSING_SPEC §7 的 L0 示意与"来源"列同步更新。

## 验收

- 场景手测 A：问"蛋白质还差多少" → AI 建议某食物 → 发"来一份" → 解析为 record 且 canonical 为 AI 建议的食物。
- 场景手测 B：候选卡选"煎饼果子"、份量卡选中份 → 发"再来一份" → 正确指代煎饼果子。
- 场景手测 C（2026-07-03 真实案例）：用户刚讨论过"葱花饼是无油的、热量估高了"，随后发"加80克鸡蛋葱花煎饼"→ parser 能从 L0 的双向记忆里带上属性，canonical 取"鸡蛋葱花煎饼（无油）"级别的具体名，不再按油煎默认估。
- ai_parse_log 每轮（含 resolve）都有 reply_summary；compressContext 输出含 AI 侧摘要。
- 单测：TurnSummary 渲染含 reply；resolve 写 log 的分支覆盖 portion_choice / food_choice / delete_confirm。
- 单测：超长 said（如 500 字）与超长 reply 渲染后被截断；5 轮全量 L0 渲染文本 ≤ ~1200 字。
- 现有测试全绿；铁律 3 复查：全链路无任何读 chat_message 喂 AI 的路径。
