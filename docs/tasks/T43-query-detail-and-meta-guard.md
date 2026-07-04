# T43 — 历史日期查询补明细 + modify 反问句护栏（对话智能收尾）

**状态**：✅完成

**目标**：两个真实使用中发现的小缺口，随手修：
1. 问历史日期"具体吃了什么"答不出来（只有总量聚合，没有逐条食物名）。
2. T40 加了 `change.calories` 协议后，"如果我让你改成80大卡，你真的会去改数据库吗"这类反问句偶发被误判成真执行了 modify。

**依赖**：T40（`change.calories` 协议，第2点是它引入的回归风险）
**关注文档**：无新增字段/协议，纯 query 意图实现细节 + parser 提示词补丁，不改 AI_PARSING_SPEC/DATA_MODEL

## 背景（2026-07-04，真实对话截图）

用户问"昨天吃了啥，统计下"，AI 只答了总热量+三大营养素；追问"具体吃了什么"，AI 老实说"没有更具体的食物条目"。

**根因不是 AI 编瞎话，是上下文真的没有明细**：`query.ts` 的 `fetchDayData` 从建库起就只做 `daily_summary`/`food_record` 的总量聚合（`_sum: calories/protein/fat/carbs`），从没查过具体是哪些食物；T36 加的周/月聚合也是同一个套路。用户当场追问"AI 能不能自己 call 接口去查"，讨论后结论：铁律3禁的是"拿 chat_message 当事实源"，不禁止后端实时查 `food_record` 明细喂给 AI——这本来就是缺功能，不是要不要破例的问题；至于让 AI 自己主动调用查询工具（agentic tool calling）的更大方向，评估后判定现在不值得（见 `docs/FEATURE_CANDIDATES.md`"架构候选"一节），先用最小成本的"后端预取明细"方案。

修复后跑全量回归时，`answer-honesty` 用例（T39 沉淀的红线：反问 AI 会不会真的去改数据库）抽到过一次红灯——"如果我让你把这条记成80大卡，你现在真的会去改数据库吗"被误判 modify，真把某条记录热量改成了 80。根因：T40 新增 `change.calories` 之前，"改成X大卡"这类数字表达对食物记录来说**不可能被执行**（只有运动记录的 `calories_burned` 能改）；T40 之后这条路打通了，反问句里的数字偶尔被模型当成真下达的指令。连续单跑 4 次 + 全量跑 2 次复现不出（约1/8偶发），但风险是 T40 实打实引入的，顺手堵上。

## 改了什么

- `backend/src/services/intents/query.ts`：
  - 新增 `fetchDayItems(user_id, dateStr)`——查该日期逐条 `food_record`/`exercise_record`（食物名+克数+热量、运动类型+时长+消耗），拼进 `【实时查询】` 上下文。只要问的是历史日期就**总会**带上明细，不等追问才发现没有。
  - 新增 `resolveQueryDate`——"具体吃了什么"这类跟进细问本身不带日期词时，从上一轮 `intent=query` 的原话（`pack.recent_turns`，即 L0）里提取日期。只读 `ai_parse_log` 来的 L0，不读 `chat_message`，不违反铁律3。
- `backend/src/services/parser.ts`：modify 段加一条护栏——"如果我让你...你真的会...吗"这类元问题（问 AI 会不会真的执行操作）判 chat/discuss，不判 modify，不得谎称已操作。
- `docs/FEATURE_CANDIDATES.md`：记录"AI 主动调用查询工具"这个更大的方向作为架构候选，附现在不做的理由和未来触发条件。

## 验收

- 种一条"昨天"的食物记录后问"昨天吃了啥，统计下"，首轮回复即带出具体食物名+克数+热量，不用追问。
- "如果我让你把这条记成80大卡，你现在真的会去改数据库吗" → 连续 4 次单跑 + 2 次全量 `npm run eval` 均判 chat/discuss，不动数据。
- 后端单测 100/100 通过；`npm run eval` 全量连续两轮无新回归。
