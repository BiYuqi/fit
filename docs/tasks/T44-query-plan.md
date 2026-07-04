# T44 — 查询计划：AI 填单、后端执行的通用历史查询（对话智能 C）

**状态**：✅完成（2026-07-04）

**验收记录**：后端单测 114/114（新增 14 个：区间解析/渲染/schema 越权拒绝/源码扫描只读护栏）；全量 `npm run eval` 连续两轮 0 新回归（query-plan 用例 7 场景全绿，含裸追问"具体吃了什么"的 L0 日期消解）；人为注入 planner 全挂 → HTTP 200 + 如实说无明细 + trace 记失败事件；token 记账出现 `query_plan` 桶（flash，单次约 1.4k tokens）；planner 真实调用 24/24 无一次升 pro。实施中发现并顺手修复：parser 对不带日期词的裸追问原判 chat（提示词补一句跟进细问归 query）。

**目标**：终结"每种新问法都要手写一对正则+一个查询函数"的困境。AI 不再只能引用预取上下文里的数字，而是对 query 意图输出一份**结构化查询计划**（受限 JSON 表单），后端校验后确定性执行 SQL、把结果拼进上下文再生成回答。覆盖"这个月吃了几次红烧肉"、"上周蛋白平均多少"、"总结我上个月饮食"这类无法穷举预取的开放式统计问题。**一步到位单路径**：T43 的正则老路（本就是妥协之策）在本任务内直接删除，不留双路径观察期。

**依赖**：T41（回归评测集）、T43（其 eval 用例是本任务的回归红线）
**关注文档**：AI_PARSING_SPEC（新增 §查询计划 一节，协议唯一定义处；删旧口径）、DATA_MODEL（无新表无新字段）、FEATURE_CANDIDATES（"架构候选"一节归档）

## 背景（为什么会有这个任务）

2026-07-04 讨论（起因见 T43 背景）：T43 用正则修好了"昨天具体吃了什么"，但这条路是打补丁——`extractQueryDate` 只认"昨天/前天/N天前/MM月DD日"，`DETAIL_FOLLOWUP` 只认固定追问词。"上周三吃了啥"、"这个月吃了几次红烧肉"、"最近哪天吃得最多"每种都要再写正则+专用查询函数，问题维度是 日期表达 × 过滤条件 × 聚合方式 × 明细/汇总 的乘积，穷举必输。

**方案不是 FEATURE_CANDIDATES 里暂缓的"给 AI 挂工具自由调用"**，而是中间态，复刻食物匹配的家传刀法（铁律4：DeepSeek 归一化 + 后端确定性匹配）：**AI 只描述"要查什么"（填一张受限表单），后端决定"怎么查、能不能查"**。AI 全程碰不到数据库，没有工具循环，恒定一次额外的 flash 调用。

当时评估"真 agentic 工具循环"的四条反对理由（延迟/成本、可测性、安全、哲学一致性）在本方案下全部化解，论证记录在 FEATURE_CANDIDATES"架构候选"一节，本任务完成后归档该节（查询计划已落地；真 agentic 循环的触发条件——多步依赖查询高频出现——保留在案）。

**为什么不留降级双路径**（2026-07-04 拍板）：正则老路只护得住"昨天/前天"这一小片，新问法本来就没有兜底；planner 的安全网改用 parser 已验证的 **flash 失败 → pro 重试** 模式，兜的是模型抖动本身，比退回正则更通用；query 是只读路径，planner 全挂的最坏结果是如实说"暂时查不到"，不脏数据，重问即可。

## 协议：QueryPlan（定稿后抄进 AI_PARSING_SPEC，此处为设计稿）

```typescript
{
  range:                      // 相对日期一律用符号，由后端确定性解析——AI 不做日期算术（铁律1精神）
    | { type: "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" }
    | { type: "last_n_days", n: number }          // "最近一周/最近10天"
    | { type: "day", date: "YYYY-MM-DD" }          // 明确日期（"6月5日"→补当年年份，未来日期后端拒绝）
    | { type: "range", from: "YYYY-MM-DD", to: "YYYY-MM-DD" },
  target: "food" | "exercise" | "both",
  food_filter?: string,       // 按食物名过滤（"红烧肉"），Prisma contains 参数化查询，绝不拼 SQL
  meal_filter?: "breakfast" | "lunch" | "dinner" | "snack",  // "6月5日晚饭吃了啥"
  detail: "total"    // 区间总量 + 衍生统计
        | "daily"    // 按天列出 + 衍生统计（区间 >31 天自动降为 total，附说明）
        | "items"    // 逐条明细（上限 40 条，超出折叠为"另有N条"）
        | "report"   // 总结用复合体：衍生统计 + daily 简表 + by_food Top5
        | "by_food"  // 按食物聚合 Top10（次数/总热量），"吃了几次X"配合 food_filter
}
```

**计划里没有 user_id 字段**——AI 想越权在词汇表上就不可能。执行器签名 `executeQueryPlan(user_id, plan)`，user_id 永远来自 JWT。

**衍生统计由执行器算好给 AI**（铁律1：AI 绝不算账）：均值、最高/最低天、记录天数、超目标天数、蛋白均值等。绝不扔 30 行原始数据让 AI 自己算平均。

## 做什么

- **新文件 `backend/src/services/intents/query-plan.ts`**：
  - `QueryPlanSchema`（zod）+ planner 的 tool schema（复用 parser 的强制 tool call 套路，`ai/schema.ts` 同款写法）。
  - `planQuery(text, pack, userId)`：flash + 强制 tool call；**flash 失败/zod 校验失败 → pro 重试一次**（与 chat.ts 解析升级同款）。走 `callDeepSeekCtx`（上下文里已有【当前日期】锚点和 L0 最近对话，"具体吃了什么"这类跟进细问由 planner 从 L0 消解日期）。token 计费 purpose 用 `query_plan`。
  - `executeQueryPlan(user_id, plan)`：通用执行器，输出【实时查询】文本块（开头回显解析后的实际日期区间，AI 才知道查的是哪几天）。**安全边界写死**：只查 `food_record` / `exercise_record` / `daily_summary` 三张表（`chat_message` 物理不可达，铁律3）；只用 findMany/aggregate/groupBy，无任何写路径；区间上限 92 天；行数上限见 detail 注释。
- **`backend/src/services/intents/query.ts` 重写查询路径**：query 意图 → planQuery → executeQueryPlan → answerQuery（answerQuery 本身不动）。**同步删除** `extractQueryDate`、`DETAIL_FOLLOWUP`、`resolveQueryDate`、`fetchDayData`、`fetchDayItems`。pro 也失败的最终兜底 = answerQuery 无 extraCtx，提示词保证如实说"暂时查不到"（不装死不编造）；失败记 trace。`isTodayQuery` 卡片判断改由 plan 的 `range.type === "today"` 决定，删正则。
- **保留的 T43 遗产（别误删）**：`parser.ts` 的 modify 反问句护栏（那是 T40 的回归修复，与查询架构无关，永久保留）；T43 沉淀的 eval 用例原样保留继续跑。
- **`backend/src/services/parser.ts` 提示词补丁**：query 意图定义补一句——总结/回顾/表现类请求（"总结下我上个月吃得怎么样"）归 query，不是 chat。
- **`backend/src/ai/answers.ts` answerQuery 提示词补丁**：detail=report/daily 的总结类查询，允许基于上下文**已算好的数字**做定性评价与建议（教练人设本来的活），仍禁自算数字、禁编造。
- **`docs/AI_PARSING_SPEC.md`**：新增 §查询计划（协议、安全边界、失败兜底），query 意图一节改为只描述新口径。
- **`docs/FEATURE_CANDIDATES.md`**："架构候选"一节归档。
- **单测**：执行器为主（各 detail × range 符号解析 × 截断/折叠 × 未来日期拒绝 × 越权不可表达——plan 里塞多余字段被 zod strip/拒）。
- **eval 用例沉淀**（一场景一用例，setup 造历史数据）：
  - 昨天明细（T43 原用例原样保留，必须继续绿）；
  - "这个月吃了几次红烧肉" → 次数正确；
  - "上周平均摄入多少/蛋白平均多少" → 引用执行器算的均值；
  - "6月X日晚饭吃了什么" → meal_filter 生效；
  - "总结下我上个月吃得怎么样" → intent=query，回复引用真实数字给建议，禁编造数字红线。
  - 注意：eval `setup:` 目前不支持种历史日期的 food_record，需要先小幅扩展 harness（`setup.food_record: [{date, food, grams}]`），扩展本身也算本任务交付。

## 不做什么（明确排除）

- 不做自由工具循环（AI 决定调几次）——延迟/成本/不确定性三输，触发条件见 FEATURE_CANDIDATES。
- 不给 modify / record 挂任何查询能力，写路径协议一字不动。
- 不做"系统主动推周报"类定时总结（超出聊天架构，另立候选）。

## 验收

- 上述 5 个 eval 场景全绿；全量 `npm run eval` 连续两轮无新回归（尤其 answer-honesty 红线）。
- 后端单测全绿；执行器单测覆盖安全边界（三表白名单、只读、区间/行数上限、未来日期、越权不可表达）。
- `query.ts` 中不再有日期/追问正则；人为让 planner 挂掉（flash+pro 都失败）→ 回复如实说明暂时查不到（禁编造、禁谎称），不 500。
- token 记账出现 `query_plan` 桶，单次查询成本增量 ≈ 一次 flash 调用。
