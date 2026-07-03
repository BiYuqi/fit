# T38 — pending 感知：用文字回答卡片（对话智能）

**状态**：✅已完成

**目标**：AI 弹卡片问"小/中/大？"后，用户**打字回答**（"中份"、"第一个"、"都不是，是酱香饼"、"180克"）也能被理解并落到 resolve，而不是被误判成闲聊或新记录。
**依赖**：T37（双向记忆，resolve 写 log 已就位）　**关注文档**：AI_PARSING_SPEC §4 §7、API_SPEC（/pending/:id/resolve）

## 背景（为什么会有这个任务）

2026-07-03 体检：MemoryPack 里没有任何 open pending 信息，parser 不知道"当前有一张卡等着被回答"。用户不点卡而打字回答是自然行为（尤其语音输入场景），现状会被路由成 chat 或新 record——"AI 问了问题却听不懂答案"，是最典型的"笨"体感，也顺带产生脏数据（把"中份"记成一条新食物或闲聊）。

## 做什么（指引，不限定实现细节）

- **注入**：buildMemoryPack 查该用户最新一条 `pending_record`（status=pending 且未过期——5 分钟窗口与前端过期口径一致），注入 MemoryPack；compressContext 输出【待确认】行，如：
  `【待确认】份量卡：煎饼果子 小(300g)/中(450g)/大(600g)，可自定克数` 或
  `【待确认】候选卡："煎饼" → 煎饼果子/鸡蛋煎饼/酱香饼`。
- **协议**：parser 新增意图 `resolve_pending`（tool schema + zod 同构）：
  `{"intent":"resolve_pending","choice":"medium"}` / `{"choice":"酱香饼"}` / `{"choice":{"grams":180}}`。
  system prompt 补规则：仅当存在【待确认】且当前消息明显是在回答它时才用此意图；用户明显在说别的（新记录、问问题）照常路由。"都不是，是X"→ choice 填 X。
- **落地**：把 `/pending/:id/resolve` 的核心逻辑抽成服务函数（pending.ts 路由与 chat.ts 共用），chat.ts 收到 resolve_pending 时调用它，返回与点卡等价的 messages / summary_card。
- **卡片状态同步**：文字 resolve 后原卡必须失效（前端已有 resolved/过期态机制，确认 GET /chat/messages 富化逻辑能把该卡标成已确认，防止再点一次重复入库——resolve 接口本身有 status=pending 防线，需确认体验层也一致）。
- **防误伤**：无 open pending 时，"中份"这类短语不得路由到 resolve_pending（schema 上 target 不需要，但 prompt 与后端都要兜底：无 pending 直接按原意图流程走）。
- AI_PARSING_SPEC §2 §4 补 resolve_pending 意图与路由说明。

## 验收

- 份量卡弹出后发"中份"→ 入库、出 record_card、原卡变已确认不可再点、summary 刷新。
- 候选卡弹出后发"都不是，是酱香饼"→ 按酱香饼走后续流程。
- 份量卡后发"180克"→ custom 克数入库，学习信号 custom_gram 照常记录。
- 份量卡后发"对了昨天晚饭忘记了"（答非所问）→ 不误 resolve，按正常意图路由。
- 无 pending 时发"中份"→ 不出现 resolve_pending。
- 卡片过期（>5min）后发"中份"→ 不 resolve 过期卡，礼貌提示重新描述。
- 单测：resolve 服务函数抽取后 pending 路由回归全绿。
