# AI_PARSING_SPEC — AI 解析层规范

> DeepSeek 只负责理解与估算，**绝不算最终热量**（算账见 CALORIE_ENGINE）。三层食物库见 FOOD_DB_SPEC。

## 1. 接入要点
- OpenAI 兼容：`baseURL: "https://api.deepseek.com"`，用 `openai` SDK。
- 模型：主力 **`deepseek-v4-flash`**（高频解析，低成本低延迟）；难例升 **`deepseek-v4-pro`**。
- **无状态 API**：服务端不存上下文，每次请求把所需历史 + 上下文卡一起拼进去。
- 结构化输出：用 **Tool Calls strict 严格模式**约束 JSON；返回后再用 **zod 校验**；处理偶发空响应；加 429/5xx 重试。
- key 只在后端。
- **模型升级策略（在 T05+T06 完成后实现）**：flash 默认；若任一 item `food_confidence < 0.5` 或 zod 校验失败，自动用 pro 重试一次，不再降级。前端永不指定模型。

## 2. 意图路由
每条消息先判：`record`（记录饮食/运动）/ `query`（查自己的饮食/运动数据：任意日期/区间、某食物次数、总结回顾类，见 §11）/ `modify`（改/删/追加已有记录，见 §8）/ `discuss`（针对某条已有记录提问/质疑，不动数据，见 §9）/ `resolve_pending`（打字回答上下文里的【待确认】卡片，见 §10）/ `record_weight`（上报自己的实测体重，见 §13）/ `multi`（一条消息多个互不隶属的动作，见 §12）/ `chat`（其余闲聊/营养问题）。可与解析在同一次调用完成。

## 3. record 解析协议
DeepSeek 输出（strict tool schema，zod 同构校验）：
```json
{
  "intent": "record",
  "meal_type": "lunch",
  "scene": "unknown",
  "items": [
    {
      "raw": "牛肉面",
      "canonical": "牛肉面",
      "quantity_expr": "一碗",
      "count": 1,
      "count_unit": "碗",
      "portions": [
        {"label": "small",  "grams": 350},
        {"label": "medium", "grams": 450},
        {"label": "large",  "grams": 600}
      ],
      "chosen_label": "medium",
      "food_confidence": 0.86,
      "portion_confidence": 0.55,
      "is_ambiguous": false
    }
  ]
}
```
- `canonical`：归一后的标准食物名，供匹配。须取**具体、不易撞词**的名，避免泛词被字面前缀误匹配到别的品类（"蛋白/蛋清"→"鸡蛋白"，别用会撞"蛋白粉"的"蛋白"；单字泛词补全成"米粉"/"牛奶"等）。见 §5。
  - **主食取明确熟形**（库里主食多为生/干重，套用热量虚高 2~3 倍）："糙米"→"糙米饭"、"面条/挂面"→"熟面条"、"燕麦"→"燕麦粥"；除非用户明说"生的/干的"。见 FOOD_DB_SPEC 生/熟口径。
- `portions`：每份量的克数估算（数据库不存克数，全由此估）。
- `chosen_label` 必须指向 `portions` 中真实存在的档；用户明示精确数量（"100克"/"200ml"）时须含等值 `custom` 条目。后端 schema 层有归一化护栏（`ensureChosenPortion`，T42）：缺档时从 `quantity_expr` 提取数量补 custom，提不出则回退 medium——绝不回退小份，防止明示克数被静默改档。
- `scene`：进食场景 `takeout | canteen | home | unknown`，**只从原话提取，不靠常识猜**（"点了个外卖麻辣香锅"→takeout；"食堂打的饭"→canteen；"自己煮的"→home；提不出→unknown）。落 `food_record.scene`，scene 层偏差参与份量修正融合（unknown 不参与），见 LEARNING_SPEC §4（T32）。
- `count` / `count_unit`：可数份量的**结构化份数 + 量词**，只供餐食卡展示 `食物名 ×count`（如「两个包子」→ `count:2, count_unit:"个"`；「一碗面」→ `1, "碗"`）。**仅在原话有明确可数份量时填**；纯重量/容量表达（"50克瘦肉"、"200ml 牛奶"）**留空**——克数已由 `portions` 承载，别硬凑量词。与热量计算完全无关（铁律 1），落 `food_record.count/count_unit`。`quantity_expr` 仍照旧保留（自由文本，护栏用），二者不互相替代。
- `is_ambiguous`：AI 语义判断食物名是否有歧义（如"煎饼"可指多种，"粥"可指多种）。
- `calories_override`（T66）：用户在描述食物时**直接给出该条目最终热量**（"一个自制冰激淋80卡"），是用户真值，不是 AI 估算。后端不再按 `food×grams` 算，直接按此值入库（`food_record.calories_source=user_override`），宏量素按系统本会算出的比例回推（`scaleNutritionToCalories`，同 §8 `change.calories` 口径）；填了这个不代表可以省略 `portions`/`chosen_label`——克数估算仍要正常填，只供展示与学习基准，不参与算账。**给了 `calories_override` 就不再弹份量卡**：食物已确定（或经候选卡确认）时直接采信入库，不因份量置信度低而追问份量。意图判定边界：陈述吃了什么并报出热量是 `record`（"一个自制冰激淋80卡"），**问**热量才是 `chat`（"自制冰激淋一般多少卡"）——2026-07-13 真机曾把陈述句整句判成 `chat`，用户被迫吵4轮才记进去一个数字。
- 运动则输出 `{type, duration_min, intensity?}`，热量后端按 MET 估或简表。
- `date_offset`（T62，补记跨天）：相对今天的天数偏移，仅在原话有相对日期词时填——"昨天/昨晚/昨日"→-1，"前天"→-2，"大前天"→-3；范围 -3~0，不填=当天。后端确定性正则（`extractDateOffsetFromText`）优先于这个字段，同 `meal_type` 的既有覆盖模式（正则比模型判断更可靠）。落 `food_record.date`/`exercise_record.date`；候选卡/份量卡等异步确认场景，这个日期会先存进 `pending_record.candidates.record_date` 再传到最终落库，不会因为确认延迟摔回发消息当天。

## 4. 歧义判定与路由规则

歧义判定采用**双信号 OR**，任一为真即走 CandidateCard：
- `is_ambiguous = true`（AI 语义判断）
- DB 候选热量离散度 `calorie_spread > 100 kcal/100g`（matchFoodCandidates 返回）

| 判定结果 | 行为 |
|---|---|
| 歧义（双信号任一为真） | CandidateCard：列出候选食物，每项显示默认中份热量；点击选定食物后再出 PortionCard 确认份量（两步串行） |
| 不歧义 + 食物高 + 份量高 (>0.8) | 自动入库，并入当餐 meal_card（一餐一卡，T46；卡片契约见 API_SPEC） |
| 不歧义 + 份量不确定 | PortionCard：份量给 小/中/大（含热量）让用户选 |
| 食物低置信 (<0.5) | clarify_card（极少见，是解析失败兜底） |

食物歧义优先于份量歧义：命中歧义先出 CandidateCard，选定食物后接 PortionCard 确认份量（现状为两步串行；「候选卡一步化」——点击即按默认档入库、档位卡上可改——为暂定候选方案，见 `FEATURE_CANDIDATES.md`）。
中/低置信生成 `pending_record`，前端出对应卡片，用户选择后走 `/pending/:id/resolve`（点卡）或打字回答由 `resolve_pending` 意图路由到同一逻辑（见 §10）。

> 以上为 `record` 路由。`modify`（改/删/追加）的路由与确认策略单独见 §8。

## 5. 食物匹配管线（无 embedding）
```
matchFoodCandidates（歧义检测）：
  1. 精确匹配 food_standard.name
  2. alias 匹配
  3. 前缀匹配 name LIKE 'query%'（捕获泛称→具体变体，如"煎饼"→煎饼果子）
  4. pg_trgm 模糊匹配（similarity ≥ 0.4）
  5. 四路结果去重合并，返回候选列表 + calorie_spread（所有候选热量极差）

matchFood（单一最佳匹配）—— 字面只召回，AI 裁决（防"蛋白→蛋白粉"字面误匹配）：
  1. 精确匹配 name → 可信，直用
  2. alias 匹配 → 可信，直用
  3. 前缀匹配，分真假：
       真 specialization（name==canonical，或 canonical 之后紧跟分隔符如「（(空格、，」）→ 直用（代表值优先）
       假前缀撞词（canonical 后接正文字，如 蛋白→蛋白粉）→ 转"可疑候选"
       限定符含"生/干/挂面/切面"的（如 面条（生，代表值））**不算真 spec** → 转"可疑候选"（生/熟，见 FOOD_DB_SPEC）
  4. pg_trgm（≥0.4）命中 → 也进"可疑候选"
  5. 无任何候选 → DeepSeek 估营养 → 落库 is_estimated=true
  6. 有可疑候选 → 回灌 DeepSeek 裁决（带用户原话 raw + 候选名/类目/热量）：
       · 类目仅作判断信息，不硬排除（category 取自文件名，粗，不给一票否决）
       · 生/熟不符判不相符：候选是生食材/干货（含"生/干"或本就是干货如糙米/大米）而用户吃的是熟食成品 → 选 none 去估熟食
       · 复合菜不等于单一食材判不相符：用户说的是炒/烧/焖/煮/卤/拌等加工成品（炒面、炒饭、黄焖鸡……），候选是"单一食材"标记的裸食材/半成品（如熟面条、米饭，无油无配料）→ 选 none 去估复合菜（把油、肉、配料都算进去）；只有候选本身也标"复合菜"且确为同一道菜才能选
       · "以上都不是"为显式一等选项，选它直接走第 5 步估算，不诱导硬选
  7. AI 否决 → 估算落库。宁可估算，不硬套一个错条目（错条目悄悄写错数据，危害大于诚实估算）
```
> 裁决权归 AI 不归字面相似度。配套：parse 阶段 canonical 取具体名（"蛋白"→"鸡蛋白"，见 §3）从源头减少撞词。
> 这是"字面误匹配"，与 §4 的"一对多变体歧义（煎饼）"是两个不同的病，分开处理。
匹配命中后，后端按 chosen_label 的克数交给计算引擎算账。

### 主料覆盖校验（T67，不依赖模型自评的确定性校验）
复合菜（肉/蛋/海鲜等主料 + 主食/汤/菜的组合）的 `canonical` 可能把主料静默简化掉（"煎鸡胸肉汤面条"→"熟面条"），此时 `food_confidence` 仍可能给高分——**置信度是模型自评的，本身就可能是虚高、错的**，§4 里"食物低置信 (<0.5)"这道安全网因此形同虚设。
- 校验独立于置信度，在 `parseUserInput`（`parser.ts`）完成，零额外 LLM 调用：复用 `explicit-signals.ts` 的 `extractExplicitSignals(原话).ingredients` 拿到原话里的主料名，`ingredientCovered(主料, canonicals)` 判断是否被该 record（或 multi 的某个 record op）的全部 item `canonical` 覆盖（内置同义词表，"鸡蛋"能被"水煮蛋"满足）；`derivedRequest` 为真（"纯肉不算骨头"）时整体跳过，避免用户主动要求派生值被误判成丢主料。
- 校验对象只能是 `canonical`，绝不能是 `raw`——`raw` 是用户原话回显，必然包含主料词，用它判会永远全绿。
- 结果通过 `parseUserInput` 返回值的 `needsUpgrade: boolean` 带出（不写回 item、不改 `food_confidence`——归一化跑在 zod parse 之前，挂在 item 上的内部标记会被 `z.object()` 剥掉）。`chat.ts` 的 flash→pro 升级判断改为 `needsUpgrade || food_confidence < 0.5`，两个信号并列触发，互不替代。
- 规则刻意保守，宁可漏报不可误报（`npm run audit` 首版曾把该栏报成 25.6%，人工复核后 6.1%，多数是"鸡蛋→水煮蛋"这类正常同义归一或用户明说的派生值）。

## 6. 上下文卡（查询用，且适配无状态 API）
进 Chat 页时后端预生成，**只放聚合值不放原始记录**，token 极小，每记一条刷新，随请求一并传给 DeepSeek。
```json
{
  "today":     {"in":1320,"out":1900,"deficit":580,"p":70,"f":40,"c":150,"remaining":580},
  "yesterday": {"in":1500,"deficit":400,"p":80,"f":50,"c":160},
  "week":      {"avg_deficit":-450,"logged_days":6},
  "month":     {"logged_days":23,"avg_in":1400},
  "targets":   {"calories":1600,"protein":110}
}
```
`query` 意图：所有查询走**查询计划**（§11）实时查库，回复为纯文本气泡（AI 文字自包含数字，不套进度卡）。

> 区分：**显示用全量聊天记录（chat_message），喂 AI 用「对话记忆包」（§7）**。两者不同，别混。上下文卡是记忆包里的 L2 聚合层。

## 7. 对话记忆包（无状态 API 的上下文拼装）

> DeepSeek 无状态（§1）：每轮把下面**三层一起拼进请求**，让 AI「不丢上下文、不显得愚蠢」。三层分工不可混。
> **铁律 3 延伸**：`chat_message` 是展示层，**绝不喂 AI**。对话记忆从 `ai_parse_log`(+join `food_record`) 抽，不从 `chat_message` 取。

| 层 | 内容 | 解决 | 来源 | 取多少 |
|---|---|---|---|---|
| **L2 画像·永久** | `user_profile` + 上下文卡（§6）+ `recent_days`（近3天每日明细） | 「懂我」：体重/目标/缺口/剩余额度；能答「昨天/前天/大前天吃了多少」 | `users` + `daily_summary`（兜底 `food_record` 实时聚合） | 固定，永久在场 |
| **L1 工作记忆·今天** | `recent_records`：今天每条记录的**当前值快照** + `ref` + `record_id` | 「A 是哪一行、现在多少克/卡」；`record_id` 供 §9 discuss 定位记录详情 | `food_record` / `exercise_record`（今天） | 今天全部，超 20 条折叠更早的 |
| **L0 对话窗口·最近** | `recent_turns`：最近几轮「用户说了啥 + AI 做了啥动作 + **AI 回了啥**」的结构化摘要（T37 双向记忆）。卡片点选（候选卡/份量卡/删除确认）也算一轮（`intent=resolve`） | 指代与时序：「那个」「再加」「不对我说中份」「（AI 刚推荐鸡胸肉）来一份」 | `ai_parse_log`（`input_text` + `parsed_json` + `reply_summary`） | 最近 **5 轮**，**滑动窗口** |

L1 句柄（`ref` 供 L0 与 §8 modify 的 `target` 引用；`record_id` 是数据库主键，供 §9 discuss 查完整记录）：
```
【今日已记录】(共2条)
  r1 午餐·牛肉面 中份 450g 600kcal [id=uuid-a]
  r2 早餐·鸡蛋 中份 50g 72kcal [id=uuid-b]
```

L0 摘要（**去卡片 payload、去闲聊长文本**，只留意图 + 动作锚点 + AI 回复摘要，否则上下文变吵）。每轮带相对时间前缀（北京时间）：今天 `[HH:mm]`、昨天 `[昨天HH:mm]`、更早 `[M月D日]`——隔夜对话不再被当成"刚刚说的"。每轮末尾的 `AI:"…"` 段是双向记忆（T37）：取自 `ai_parse_log.reply_summary`，AI 记得自己说过什么、推荐过什么；卡片点选渲染为「卡片确认」轮：
```
【最近对话】(旧→新)
  [昨天21:03] 用户:"晚饭吃了牛肉面" → 记录(牛肉面/medium)；AI:"已记录：牛肉面 450g（约 600 kcal）…"
  [08:12] 用户:"[点选卡片]" → 卡片确认(煎饼果子/medium)；AI:"确认：煎饼果子 中份 450g"
  [08:15] 用户:"蛋白质够吗?" → 查询；AI:"还差 35g，建议来份鸡胸肉"
```

> **滑动窗口**：L0 只取最近 **5 轮**，更老丢弃——「记得几段、再远就忘」。L1 是事实快照不是对话，今天全留（超 20 条折叠旧的）。
> **预算护栏（T37）**：渲染时用户原话截断 ~60 字、AI 回复摘要截断 ~150 字（超出加"…"）——长语音转文字不撑爆 L0。原则：上下文靠分层衰减控量（近的原始、远的聚合），不靠拉长窗口。

### 统一 AI 调用入口（`ai/ctx.ts`）

所有需要用户上下文的 AI 调用（`parseUserInput`、`answerChat`、`answerQuery`、`answerDiscuss` 等）统一走 `callDeepSeekCtx(pack, messages, opts)`。该函数内部调用 `compressContext(pack)` 压缩三层上下文，作为 system message 在第一条 user message 之前强制注入。

```
callDeepSeekCtx(pack, messages, opts)
  └─ compressContext(pack) → 压缩文本：
       【当前日期】今天是 YYYY-MM-DD（北京时间）
       【用户档案】…
       【今日进度】摄入/目标/剩余/蛋白
       【本周】平均缺口Xkcal 已记录N天（取自卡 week，answerQuery 答周均值的数据源）
       【本月】平均摄入Xkcal 已记录N天（取自卡 month，同上）
       【近3日每日摄入】YYYY-MM-DD 摄入Xkcal …（有记录的天才输出）
       【今日已记录】[max20] r1/e1 …
       【最近对话】[max5轮] 旧→新，每轮带相对时间前缀（今天HH:mm/昨天HH:mm/M月D日）+ AI 回复摘要（said截断60字/reply截断150字）
  └─ 插入 system message → callDeepSeek(fullMessages, opts)
```

**规则**：纯食物知识类调用（`estimateByAI`、`adjudicateByAI`）不涉及用户状态，继续直接用 `callDeepSeek`，不走此入口。

## 8. modify 意图：指代修改（改 / 删 / 追加）

承接 §2。`modify` **不由 AI 算账**——AI 只产出「改哪条 + 怎么改」，`target` 引用 §7 `recent_records.ref`；后端重新匹配 + 重算（calc）。**例外**：`change.calories`（用户亲口报的热量数字）是用户真值，直接采信落库，铁律 1 禁的是 AI 算账，不禁用户报数。

`action` 三选一：
- **update**：改已有记录的份量/食物/餐次/热量/宏量素/属性。如「牛肉面换大份」「不对，是牛肉拉面」「粽子是中午吃的」（改餐次 `change.meal_type`，数值不动）「记录成180kcal」（`change.calories`，T40）「把蛋白质改成8克」（`change.protein`，T64）「无油款」（`change.food_desc`，T40）
- **delete**：删整条记录。如「早餐那个蛋删了」「把李子删了」（无量词限定，判整条清空）
- **append**：在 `target` 所属**那一餐里新增**记录（继承 `meal_type`/时段），新项走正常匹配 + 份量流程。如「早餐再加个蛋」

**量词减量不是整条删除**（T49）：用户只想去掉部分数量（"删掉一个"、"少一个"、"其实只吃了一个"），且 L1 里该记录的份量明显对应多份/多个（如"2个李子"记了60g）→ 判 `action=update`，`change.grams` 填按比例减去这部分后的新克数（60g 删一个→30g），不判 `delete`。份量本就是单份或说不清具体几份时无法换算 → 仍按 `delete` 处理（安全兜底，宁可整条删）。

> `append` 与 `update` 的界：「牛肉面再加点」=同食物加量(update)；「早餐再加个蛋」=新项(append)。由 `action` 区分。

协议（strict tool schema + zod 同构）：
```json
{"intent":"modify","action":"update","target":"r1","change":{"portion_label":"large"}}
{"intent":"modify","action":"update","target":"r1","change":{"meal_type":"lunch"}}
{"intent":"modify","action":"update","target":"r1","change":{"calories":180}}
{"intent":"modify","action":"update","target":"r1","change":{"protein":8}}
{"intent":"modify","action":"update","target":"r1","change":{"food_desc":"无油"}}
{"intent":"modify","action":"update","target":"r1","change":{"date_offset":-1}}
{"intent":"modify","action":"append","target":"r1","items":[ /* 蛋,结构同 §3 items */ ]}
{"intent":"modify","action":"delete","target":"r1"}
{"intent":"modify","action":"update","target":["r3","r4","r5"],"change":{"meal_type":"breakfast"}}
```

**批量改餐次**（2026-07-04 立项）：`target` 允许 ref 数组，**仅用于 `update` + `change.meal_type`**（"以上发的都是早餐"、"刚才那些都是晚饭"）——因为一个 `change` 只能表达一件事，多条套同一个改动才成立。后端一次 `updateMany` 改完所有食物记录 + 重算，回一条汇总文本（"已把 N 条记录改为早餐：…"），不逐条出卡、无 undo（说反了再说一句改回来即可）；受影响的新旧餐次 meal_card 全部 bump 刷新（T47，旧餐卡只刷已存在的）。
**每条改不同值一律走 multi，不用数组**（T53，2026-07-05 真机翻车立项）："玉米改180、瘦肉改50" 是两个独立修改，数组配单个 change 装不下两个不同值。parser 提示词已明确此边界（§12）；后端**护栏**：`target` 是数组但 change 不是 meal_type（不受支持的批量组合）→ **不再静默取第一个 ref 只改一条**（会算错且无法恢复），改为不动数据、回一句"分别说"提示，让失败可见。

**食物记录改热量/属性修正**（T40，`change.calories` / `change.food_desc`）：
- `change.calories`：用户直接给出食物记录的最终热量（"记录成180kcal"、"按150卡记"）。后端不重新匹配食物，直接把该值写入 `food_record.calories`，宏量素按新旧热量比例回推（不是重估），`calories_source` 置 `user_override`——同一条记录之后若被别的字段（食物/克数/属性）再次 `update`，会重新按 food×grams 计算并把 `calories_source` 落回 `computed`（该次改的不再是热量本身，旧覆盖值已经不适用）。
- `change.food_desc`：属性修正描述（"无油"、"无糖"、"去皮"、"脱脂"）。后端拼出具体变体名「原食物名（描述）」，只信任精确同名/别名命中，否则强制重新估算（**不走** §5 的弱匹配 AI 裁决——那条链路面对"字面像但营养口径不同"的候选容易误判为同一种，导致修正静默失效），产出新估算食物条目并按新食物×原克数重算。修正后 `upsertFoodAlias(原食物名 → 新food_id)`（见 LEARNING_SPEC §7），下次同名食物直连命中修正版。
- `change.protein` / `change.fat` / `change.carbs`（T64）：用户直接给出该条记录的单项宏量素克数（"把蛋白质改成8克"），是用户真值不是 AI 估算。后端**只覆盖用户点名的那个字段**，热量与其余宏量素不动，`calories_source` **保持不变**（用户纠正的是营养含量不是热量，不占用 `user_override` 语义）。若本轮同时改了食物/克数/属性，宏量素改为基于新食物重算后再叠加覆盖；若本轮只改了宏量素（食物/克数未变），未点名的宏量素字段沿用**当前记录值**而非重新按 food×grams 计算——这样连续多次分别纠正蛋白质、脂肪、碳水时互不冲掉彼此。
- 两者的撤销信息都写进该餐 `meal_card` 的 `payload.last_changes`（T47 单槽→T53 按 record_id 数组：批量改每条各留独立撤销态、同 record_id 覆盖、撤销后只清该条），不新增卡片类型；`prev_state` 带上改前的精确 `calories/protein/fat/carbs/calories_source`，撤销直接还原这些值，不按 food×grams 重算（否则会丢失 `user_override` 的用户真值）。
- 纯口感/无关描述（"有点咸"、"挺好吃"）不算修正，不触发 `change.food_desc`，整体判 chat。

**改日期**（T62，`change.date_offset`）：记录归属日错了（"是昨天的晚餐，不是今天的"、"这个记错天了"）→ `change.date_offset` 填相对今天的天数偏移，规则同 §3。**"日期词"（昨天/今天）与"餐次词"（早中晚）是两件独立的事**：用户只说错了天、没说错餐次时，`change` 里只填 `date_offset`，绝不能顺手也填 `meal_type`——这是 2026-07-11 真机事故的直接教训：四次"是昨天的晚餐"全被误判成 `change.meal_type` 且新旧值相同（记录本来就是 dinner），静默无回复，用户以为系统坏了。只有用户同时明确说错了具体哪一餐（"这是昨天中午吃的，不是晚上"）才两个都填。后端改日期是双日 `recompute`（新旧两天的 `daily_summary` 都变）+ 双卡刷新（旧日期餐卡少一项、新日期餐卡多一项），回执文案必须带出日期变化（"已把 X 改到 7月10日"），不能像改餐次改回同值那样哑火。`prev_state` 带 `date` 快照，撤销时一并还原并双日 recompute。

### 路由与确认（T49 起：免确认直删 + 事件行回执，不再弹确认卡）
| action | 置信 | 行为 |
|---|---|---|
| **delete** | 任意 | **免确认直接删除**（学习信号先写 → 删 → 重算）→ 一条 `event`（`event_type=deleted`，居中小字「已删除 X · -N kcal」+ 内联撤销）+ 该餐 meal_card bump（items 减一；全删光 → `items:[]` 已清空态） |
| **update** | 高 (>0.8) | **直接改 + 重算**，一条 `event`（`event_type=modified`，居中小字带 delta，如「已修改：米饭 100g → 200g（+130 kcal）」，不带 undo）+ 该餐 meal_card bump，撤销信息写卡的 `last_changes`（按 record_id，批量改各条独立，T53）；改餐次是**双卡刷新**（旧餐卡少一项、新餐卡多一项） |
| **append** | 高 | **直接入库新记录** + 重算，并入该餐 meal_card 并 bump，`last_changes` 追加一条 `{record_id}`（无 prev_state = 撤销即删除） |
| update / append | 低 or 歧义 | 走现成 `portion_card` / `candidate_card`（§4），不新增卡 |

> delete 撤销 = 按事件消息自带的 `payload.undo.prev_state` 快照重建记录（**新 id**），走 `POST /api/chat/events/:message_id/undo`；update 撤销 = 还原该餐 meal_card 对应 record_id 的 `last_changes` 项的 `prev_state`（走 `/api/records/:id/undo`）；append 撤销 = 删新记录（同一接口，无 prev_state）。
> **T49 起没有 action 需要确认卡**：delete 免确认直执行，update/append 沿用 T47 起的直执行 + 卡片原地刷新；存量（T49 之前）未 resolve 的 `pending(type=delete_confirm)` 仍可点旧的 `delete_confirm_card` 确认/取消，但不再有新增来源。

### 纯确认词处理
用户发极简确认词（「好」「改吧」「修改吧」「行」「ok」「确认」），若 L0 最近几轮的用户消息涉及对某条记录份量的讨论（如「不是50克吗」「应该是50g」），parser 推断 `target`（从 L1 找最近被讨论的 ref）和 `change.grams`（从讨论中提取数字），输出 `intent=modify, action=update`。推断不出具体 target 或克数则走 chat。

## 9. discuss 意图（质疑/追问已有记录，不动数据）

承接 §2。用户对 L1 里某条具体记录提问或质疑时用 `discuss`：
- 例：「为什么记成60克」「这个热量对吗」「这个份量怎么估的」
- parser 输出：`{"intent":"discuss","target":"r1"}`，`target` 引用 L1 `ref`
- 与 `query` 的区别：discuss 针对**某条具体记录**，query 是查今日**汇总数据**
- 与 `chat` 的区别：discuss 明确指向某条已有记录（从上下文推断）；推断不出则走 chat
- **与 `modify` 的边界（T65）**：判据是"有没有改动指令"，不是"语气像不像在提问"。消息里出现「改成/改为/改到/记成/记录成/算作/调成/调到」+ 紧跟具体数值，不论指令在句首还是句中、后面跟了多长的解释/论证文字，一律优先判 `modify.update`（走 §8）；`discuss` 仅用于**完全不含改动指令**的纯提问/质疑。2026-07-14 真机翻车：用户开头就发「改成850卡」，后面附一大段自己手算的食材拆解论证，曾被整句判成 `discuss`（无 `action`/`change`），指令被完全吞掉，26 秒后简化重发才生效。用户一边给指令一边讲理由，是在说明"为什么要改"，不是在征求意见。

后端处理：
1. 从 L1 `recent_records` 按 `target` 找到 `record_id`
2. 查 `food_record`（含 `raw_input`、`food_confidence`、`portion_confidence`）和关联 `food_standard`（含每100g营养）
3. 把记录详情注入 system message，调 `answerDiscuss` 解释来龙去脉（份量估算依据、克数来源、热量算法）
4. 不写 `food_record`，只回复文本气泡；回复中告知用户可说「改成X克」来调整

## 10. resolve_pending 意图（打字回答【待确认】卡片，T38）

弹卡片问"小/中/大？"或"你可能吃的是？"后，用户不点卡而**打字回答**（尤其语音输入场景）也要能被理解并落地，不能被误判成闲聊或新记录。

**注入**：`buildMemoryPack` 查该用户最新一条 `status=pending` 且未过期（创建于最近 5 分钟内，与前端 `STALE_MS` 口径一致）的 `pending_record`，写入记忆包 `pending` 字段；`compressContext` 渲染成【待确认】行（紧邻【最近对话】之前）：
```
【待确认】份量卡：煎饼果子 小(300g)/中(450g)/大(600g)，可自定克数
【待确认】候选卡："煎饼" → 煎饼果子/鸡蛋煎饼/酱香饼
```
`food_choice` 类型的候选名取自建卡时写入 `pending_record.candidates.candidate_names`（建卡时随手存一份，避免为了渲染这行而重跑食物匹配或读 `chat_message`，违反铁律 3）。

**协议**（strict tool schema + zod 同构）：
```json
{"intent":"resolve_pending","choice":"medium"}
{"intent":"resolve_pending","choice":"酱香饼"}
{"intent":"resolve_pending","choice":{"grams":180}}
```
仅当上下文存在【待确认】且当前消息明显是在回答它时才用此意图；答非所问（新记录/提问/无关闲聊）照常按真实意图路由，卡片继续挂着。无【待确认】时，`choice` 校验失败或 parser 误判都会被兜底为 `chat`（`parser.ts` 的防御归一化 + prompt 双重把关）。

**落地**：`/pending/:id/resolve` 的核心逻辑抽成 `resolvePendingRecord`（`services/pending-resolve.ts`），`routes/pending.ts`（点卡）与 `intents/resolve-pending.ts`（打字）共用同一份实现，行为完全等价（含 `status=pending` 的原子防线——查不到就是没得 resolve，防止重复入库）。

**日志归口**：`chat.ts` 已为本轮写了一条 `ai_parse_log`（`intent=resolve_pending`）。为避免 L0 出现两条重复轮次，`resolvePendingRecord` 调用时传 `skipLog:true`，改由 `intents/resolve-pending.ts` 把 resolve 出的动作回填进那条日志（`intent` 改写为 `resolve`，`parsed_json` 存 `ResolveAction`），复用既有的「卡片确认(...)」L0 渲染与指代锚点抽取——下一轮"再来一份"依然找得到锚点。

**卡片状态同步**：响应体带 `resolved_pending_id`（见 API_SPEC），前端据此把聊天流里那张旧卡就地标记 `payload.resolved=true`，防止用户在同一屏幕上对已经文字确认过的卡片再点一次。

**过期**：卡片超过 5 分钟未回答，`resolve_pending` 不再生效——后端查不到未过期的 pending，礼貌回复「已过期，请重新描述」，不落任何数据。

## 11. query 意图：查询计划（T44）

复刻 §5 食物匹配的分工哲学（铁律4）：**AI 只填一张受限的结构化查询单，后端确定性执行 SQL**。不是"给 AI 挂工具自由调用"——AI 碰不到数据库、没有工具循环，恒定一次 planner 调用。

**流程**：parser 判 `query` → planner（flash + 强制 tool call，失败升 pro 重试一次）产出 QueryPlan → `executeQueryPlan` 校验并查库 → 结果拼成【实时查询】文本注入 `answerQuery`。实现在 `services/intents/query-plan.ts`。

**协议**（strict tool schema + zod `.strict()` 同构）：
```json
{
  "range":  {"type": "today|yesterday|this_week|last_week|this_month|last_month"},
            // 或 {"type":"last_n_days","n":7} / {"type":"day","date":"2026-06-05"} / {"type":"range","from":"…","to":"…"}
  "target": "food|exercise|both",
  "food_filter": "红烧肉",          // 可选，按食物名过滤（contains，参数化查询）
  "meal_filter": "dinner",          // 可选，只查某一餐
  "detail": "total|daily|items|report|by_food"
}
```
- **相对日期一律用符号**，由后端 `resolveRange` 确定性解析（周一为一周之始）——AI 不做日期算术（铁律1精神）。明确日期（"6月5日"）才用 `day`。
- `detail`：`total` 总量+统计；`daily` 按天列（>31天自动降 total）；`items` 逐条明细（上限40条折叠）；`report` 总结复合体（统计+按天+常吃Top5）；`by_food` 食物排行 Top10。
- **衍生统计由执行器算好**（日均/最高最低天/超目标天数），绝不扔原始行让 AI 自己算（铁律1）。

**安全边界（写死，永不放宽）**：计划里**没有 user_id 字段**（执行器的 user_id 永远来自 JWT，词汇上无法越权）；只查 `food_record`/`exercise_record`/`daily_summary` 三张事实表，`chat_message` 物理不可达（铁律3）；只读（无任何写路径，`query-plan.test.ts` 有源码扫描测试兜底）；区间上限 92 天；未来日期拒绝。zod `.strict()`：计划里出现任何多余字段整单拒绝。

**失败兜底**：planner flash+pro 均失败 → `answerQuery` 无 extraCtx 直接回答，提示词保证对上下文没覆盖的数据如实说"没有记录"，不编造、不 500。失败与升级都记 trace（`decision` event，`meta.stage="query_plan"`）——失败率是"计划 schema 是否够用"的观察指标。

**跟进细问**（"具体吃了什么"不带日期词）：planner 走 `callDeepSeekCtx`，从 L0【最近对话】沿用上一轮查询的日期，无需正则。

## 12. multi 意图：复合动作（T45）

一条消息包含多个互不隶属的动作时（"把刚才吃的粽子删除了，我记得早晨还吃了30克葱花饼，无油的"），单意图协议装不下。2026-07-04 真实翻车：两个动作被缝合成一个 modify——"无油"安到了粽子头上（触发属性修正重估）、删除丢失、葱花饼没记。

**协议**（strict tool schema + zod 同构）：
```json
{"intent":"multi","ops":[
  {"intent":"modify","action":"delete","target":"r7","raw":"把刚才吃的粽子删除了"},
  {"intent":"record","meal_type":"breakfast","raw":"我记得早晨还吃了30克葱花饼，无油的",
   "items":[ /* 葱花饼（无油）,结构同 §3 items */ ]}
]}
```

- `ops` 只允许 `record` / `modify`（2~4 个），按用户叙述顺序执行；`query`/`chat`/`discuss` 不进 ops（动作里夹闲聊则忽略闲聊，夹查询则只执行动作）。
- 每个 op 另带 `raw`：该动作对应的**原文子句**（照抄）。后端把 `raw` 当该 op 的 text 用——餐次关键词提取、pending 的 raw_input、估算上下文都按子句走，防止动作间修饰词互相污染（"无油"只属于葱花饼那个子句）。
- `target`（r*/e*）一律按消息开始时的 L1 快照解析，op 之间**不重建**记忆包；执行是顺序循环调用单意图 handler，卡片逐个累积在同一 `messages` 里，回复按换行拼接。
- 路由与确认不变（§8）：ops 里的 delete 照常免确认直删 + 事件行撤销，record/update 照常高置信自动入库 + 撤销、低置信出份量/候选卡。
- 防御（parser 归一化，与 §3 record 空壳降级同段）：空壳 op（record 无 items/exercise、modify 缺 action/target）剔除；只剩 1 个拍平成对应单意图；全无降级 chat——硬拒会触发 pro 重试链，两个模型都犯错时整条消息兜底 chat 丢掉全部动作，比拍平更糟。
- 一句话报多个食物（"吃了A和B"）是**一个** record 的多个 items，不是 multi；单动作消息绝不用 multi。

## 13. record_weight 意图：上报实测体重（T51）

用户在聊天里报自己当天称出来的体重（"今天体重77.75公斤"、"现在体重到了68了"、"早上称了154斤"）。2026-07-05 真实翻车（账号 outoftoken）：聊天里没有写体重的路径，AI 却反复承诺"我来帮你存上"，`weight_log` 始终 0 行，用户陷入死循环。

**协议**：`{"intent":"record_weight","weight_kg":77.75}`。`weight_kg` 换算成公斤（"斤"÷2）、合理范围 20~500。

- **只 append `weight_log` 一个历史点**（同一天多次覆盖当天那行，upsert by `(user_id, date)`），**绝不触碰 `User.weight_kg`（初始体重）/ `target_weight_kg`**——这正是用户要的"你只负责记录，不用改我的初始体重"。落地在 `intents/record-weight.ts`。
- 与设置页那条 `upsertWeightLog`（fire-and-forget、静默失败）不同：这里是用户显式指令，写入 **awaited、失败抛异常**（由 `chat.ts` catch 转诚实报错），绝不"说存了其实没存"。回执确认已记 + 相对上次实测点/初始体重的增减趋势。
- 边界：询问体重（"我现在多少斤"）是 `query`/`chat` 不是记录；食物/份量克数（"150克米饭"）、目标体重设定（"想减到65"）都不是 record_weight。报体重又同时报吃/动时优先 record，体重点这轮略过（ops 只收 record/modify）。
- 上下文回填：记忆包 `profile.latest_weight_kg/date`（最近一个 `weight_log` 点）注入【用户档案】，AI 答"现在体重多少"引用实测值而非过时的档案初始体重。
