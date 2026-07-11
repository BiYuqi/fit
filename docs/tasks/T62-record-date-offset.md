# T62 — 补记跨天：record 识别"昨天/前天"落对日期 + modify 能把记录改到别的自然日

**状态**：✅已完成

**目标**：用户说"昨晚吃了XX"/"前天中午的XX"时，`record` 直接把记录落到正确的自然日，而不是一律写成发消息当天；发现日期记错了，`modify` 能像改餐次/改份量一样把记录"改到昨天"，而不是无能为力。

**依赖**：无。碰 `ai/schema.ts`（record 顶层 + modify.change 协议）、`parser.ts`（prompt + 确定性文本提取）、`record.ts`/`food-item.ts`/`pending-resolve.ts`（写入日期）、`modify.ts`（改日期 + 双日 recompute）、`lib/dates.ts`（加日期偏移 helper）。
**关注文档**：`AI_PARSING_SPEC.md` §3（record 协议）、§8（modify 协议）。

## 背景（2026-07-11 真机，账号 outoftoken）

凌晨 02:09 用户说"昨晚晚餐一个200毫升牛奶，昨天中午的干豆角炖土豆250克"——两条食物都带明确日期限定词，但 `record` 无视了它们，两条全部落成发消息当天（`date=2026-07-11`）。此前 AI 在同一轮对话里还主动承诺"你可以直接用'昨晚晚餐吃了XX'或'补记昨天晚餐XX'……我帮你走记录流程"——**这个能力当时根本不存在**，是白纸黑字的空头支票。

用户发现记错后连续四次纠正"是昨天的晚餐，不是今天的"，全部被解析成 `modify: action=update, change={meal_type:"dinner"}`——因为 `change` 协议里没有 `date` 字段，模型只能从"晚餐"两个字里硬凑一个 meal_type，而记录本来就是 dinner，四次"修改"全是新旧值相同的空操作，静默无回复，用户以为系统坏了，实际是这条纠错路径压根没被设计过。

两条脏数据已用一次性脚本手工订正（`FoodRecord` 日期改回 07-10 + `recompute` 两天的 `daily_summary`），脚本用后即删，不留在仓库。本任务是把"改日期"这条能力真正做出来，而不是每次真机翻车再手工修数据库。

## 设计要点

### A. 统一字段：`date_offset`（相对偏移，不是绝对日期字符串）
`record` 顶层与 `modify.change` 都新增可选整数字段 `date_offset`：0 或不填 = 当天，负数 = 过去第几天（-1=昨天，-2=前天，-3=大前天）。**不用绝对日期字符串**——prompt 里已注入`【当前日期】今天是 YYYY-MM-DD`（`ctx.ts:113`），但让模型自己算月末/跨月的绝对日期容易出错；相对偏移是模型确定性最高的表达。范围收紧到 **-3~0**（昨天/前天/大前天，覆盖真实补记场景；更早的日期极少见，且加大误判"上周几"这类模糊表达的风险，暂不支持，需要再单开）。

### B. 确定性文本提取兜底，AI 只做兜底
仿 `extractMealTypeFromText`（`lib/dates.ts`）的既有模式：新增 `extractDateOffsetFromText(text)`，正则识别"昨晚/昨天/昨日"→-1，"前天"→-2，"大前天"→-3；命中时**优先于 AI 输出**，AI 的 `date_offset` 只在正则没命中时兜底（比如"3号中午"这种非相对表达，交给 AI 结合上下文日期换算，允许自己判断范围内的偏移）。原因同 `extractMealTypeFromText` 的注释：模型对"补记"类消息的既有 few-shot 少，不如正则识别一个高频封闭词表可靠，别把这类确定性强的信号交给概率模型。

### C. record 侧：`recordDate` 与 `chatDate` 分离
`record.ts` 现有 `dateObj`（发消息当天，UTC 午夜 `Date`）**含义不变**，继续用于 `chat_message.date`（铁律3：聊天记录是展示层，不跟着记录倒退，气泡还是显示在发消息当天的会话里）。新增 `recordDate = addOffsetDays(dateObj, date_offset)`，只用于：
- `food_record.date` / `exercise_record.date`（真正归属的自然日）
- `refreshMealCard` 的 `mealDate` 参数（该函数早就把 `mealDate` 和 `chatDate` 设计成独立参数，注释写明"跨天修改时二者可不同"——本任务是第一次真正用上这个口子，之前一直传的是 `today`）
- `recompute(user_id, recordDate)`（重算的是食物归属的那一天，不是发消息那天；若 `date_offset≠0` 则**只需重算 recordDate 这一天**，不涉及 today，因为 today 当天没写入任何记录）

`lib/dates.ts` 新增 `addOffsetDays(date: Date, offsetDays: number): Date`（UTC 午夜整数天平移，配 `@db.Date` 字段）。

### D. pending 卡片（歧义/低置信）也要记住目标日期
`PendingRecord.candidates` 是 jsonb，无需迁移：`food-item.ts` 建候选卡/份量卡时把 `record_date`（`YYYY-MM-DD`）连同 `meal_type`/`scene` 一起存进 `candidates`；`pending-resolve.ts` 读 `candidates.record_date`，**没有则回退 `todayStr()`**（存量 pending 兼容）。否则"昨晚吃的不确定是啥的XX"走候选卡流程，选定食物后又会摔回发消息当天。

### E. modify 侧：`change.date_offset` 改天
`modify.ts` 的 update 分支新增：命中 `change.date_offset` 时，`prevDate = rec.date`，`newDate = addOffsetDays(今天, date_offset)`，`update foodRecord.date`；**两天都要 recompute**（`prevDate` 少了一条、`newDate` 多了一条，daily_summary 两边都变）。事件回执文案必须**明确带出日期变化**（如"已把 干豆角炖土豆 改到 7月10日"），不能像本次事故一样因为"新旧值相同"就哑火——这次哑火的根因是把"改日期"误判成"改餐次"且值没变，只要 `date_offset` 和 `meal_type` 是两个独立字段，"值相同所以不回复"这个问题自然消失（`date_offset` 一定和当前记录的日期不同，否则用户不会发这句话）。
`prev_state`（撤销用）新增 `date` 快照；撤销时把 `date` 也还原，并对旧 `newDate`、新 `prevDate` 两天各自 `recompute` 一次。
跨天的 `update`，其所属 `meal_card` 也要双卡刷新（参考现有"改餐次"是双卡刷新的先例，`AI_PARSING_SPEC.md §8` 路由表）：旧日期那天的餐卡少一项，新日期那天的餐卡多一项。

### F. prompt 规则：与"改餐次"划清界限（本次事故的直接教训）
`parser.ts` 的 modify 段落新增明确示例和反例：
- "是昨天的晚餐，不是今天的" → `change.date_offset=-1`（**不要**顺手也填 `change.meal_type`，用户没说错餐次，只说错了天）
- "粽子是中午吃的" → 仍是 `change.meal_type=lunch`（同一天内改餐次，`date_offset` 不填）
- 两者可以同时出现（"这是昨天中午吃的，不是晚上"）→ `change.date_offset=-1` **且** `change.meal_type=lunch`，都填
关键教训写进 prompt：**"昨天/今天"是日期词，"早中晚"才是餐次词，不要把日期词误当餐次词的同义替换**——这正是本次四次纠正全部失败的原因。

## 验收
1. 真机发"昨晚吃了个粽子"（当前时间已过零点）→ `food_record.date` 是发消息前一天，不是当天；`daily_summary` 只有那一天变化，今天的不受影响。
2. 真机发"前天中午的红烧肉200克，不确定是不是這个牌子"这种会触发候选卡的表达 → 选定食物后记录仍落在前天，不回退到今天。
3. 复现本次事故原句："XX是今天的" 记完后发"不对，是昨天的" → 记录日期改到昨天，回执文案带出日期变化，原日期与新日期两边的 `daily_summary`、`meal_card` 都正确刷新；再发"改回来"（或点撤销）能还原。
4. 发"粽子是中午吃的"（改餐次，不提日期）→ 只变 `meal_type`，`date` 不动——确认没有把 §F 的新逻辑和老逻辑混在一起。
5. `npm run eval`（干净端口，不打 :9300）新增至少 2 条用例覆盖 1/3，全绿。

## 提示词（可粘贴）
> 按本文件「设计要点 A→F」执行 T62。核心是给 `record` 顶层和 `modify.change` 都加 `date_offset`（-3~0 相对偏移，不用绝对日期字符串），`lib/dates.ts` 加 `addOffsetDays` 和仿 `extractMealTypeFromText` 的 `extractDateOffsetFromText`（确定性文本优先于 AI）。`record.ts` 区分 `recordDate`（食物归属日，用于 food_record/recompute/meal_card 的 mealDate）和 `dateObj`（发消息当天，聊天气泡不变，铁律3）。`pending-resolve.ts` 要把 `record_date` 存进 `candidates` jsonb 再读回来，否则候选卡场景会摔回今天。`modify.ts` 改日期要双日 recompute + 双卡刷新 + prev_state 带 date 支持撤销。prompt 里务必讲清楚"日期词≠餐次词"这条本次翻车的直接教训。完成后 `npm run eval`（干净端口，别打 :9300，参考 CLAUDE.md 的端口备注）。遵守 CLAUDE.md 铁律 1/3/10/12。
