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
每条消息先判：`record`（记录饮食/运动）/ `query`（查自己的饮食/运动数据：任意日期/区间、某食物次数、总结回顾类，见 §11）/ `modify`（改/删/追加已有记录，见 §8）/ `discuss`（针对某条已有记录提问/质疑，不动数据，见 §9）/ `resolve_pending`（打字回答上下文里的【待确认】卡片，见 §10）/ `chat`（其余闲聊/营养问题）。可与解析在同一次调用完成。

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
- `is_ambiguous`：AI 语义判断食物名是否有歧义（如"煎饼"可指多种，"粥"可指多种）。
- 运动则输出 `{type, duration_min, intensity?}`，热量后端按 MET 估或简表。

## 4. 歧义判定与路由规则

歧义判定采用**双信号 OR**，任一为真即走 CandidateCard：
- `is_ambiguous = true`（AI 语义判断）
- DB 候选热量离散度 `calorie_spread > 100 kcal/100g`（matchFoodCandidates 返回）

| 判定结果 | 行为 |
|---|---|
| 歧义（双信号任一为真） | CandidateCard：列出候选食物，每项显示默认中份热量；点击选定食物后再出 PortionCard 确认份量（两步串行） |
| 不歧义 + 食物高 + 份量高 (>0.8) | 自动入库，直接反馈 record_card |
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
       · "以上都不是"为显式一等选项，选它直接走第 5 步估算，不诱导硬选
  7. AI 否决 → 估算落库。宁可估算，不硬套一个错条目（错条目悄悄写错数据，危害大于诚实估算）
```
> 裁决权归 AI 不归字面相似度。配套：parse 阶段 canonical 取具体名（"蛋白"→"鸡蛋白"，见 §3）从源头减少撞词。
> 这是"字面误匹配"，与 §4 的"一对多变体歧义（煎饼）"是两个不同的病，分开处理。
匹配命中后，后端按 chosen_label 的克数交给计算引擎算账。

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
`query` 意图：所有查询走**查询计划**（§11）实时查库；今日问题的 `query_card` 展示与否也由计划的 `range.type` 判定。

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
- **update**：改已有记录的份量/食物/餐次/热量/属性。如「牛肉面换大份」「不对，是牛肉拉面」「粽子是中午吃的」（改餐次 `change.meal_type`，数值不动）「记录成180kcal」（`change.calories`，T40）「无油款」（`change.food_desc`，T40）
- **delete**：删一条。如「早餐那个蛋删了」
- **append**：在 `target` 所属**那一餐里新增**记录（继承 `meal_type`/时段），新项走正常匹配 + 份量流程。如「早餐再加个蛋」

> `append` 与 `update` 的界：「牛肉面再加点」=同食物加量(update)；「早餐再加个蛋」=新项(append)。由 `action` 区分。

协议（strict tool schema + zod 同构）：
```json
{"intent":"modify","action":"update","target":"r1","change":{"portion_label":"large"}}
{"intent":"modify","action":"update","target":"r1","change":{"meal_type":"lunch"}}
{"intent":"modify","action":"update","target":"r1","change":{"calories":180}}
{"intent":"modify","action":"update","target":"r1","change":{"food_desc":"无油"}}
{"intent":"modify","action":"append","target":"r1","items":[ /* 蛋,结构同 §3 items */ ]}
{"intent":"modify","action":"delete","target":"r1"}
```

**食物记录改热量/属性修正**（T40，`change.calories` / `change.food_desc`）：
- `change.calories`：用户直接给出食物记录的最终热量（"记录成180kcal"、"按150卡记"）。后端不重新匹配食物，直接把该值写入 `food_record.calories`，宏量素按新旧热量比例回推（不是重估），`calories_source` 置 `user_override`——同一条记录之后若被别的字段（食物/克数/属性）再次 `update`，会重新按 food×grams 计算并把 `calories_source` 落回 `computed`（该次改的不再是热量本身，旧覆盖值已经不适用）。
- `change.food_desc`：属性修正描述（"无油"、"无糖"、"去皮"、"脱脂"）。后端拼出具体变体名「原食物名（描述）」，只信任精确同名/别名命中，否则强制重新估算（**不走** §5 的弱匹配 AI 裁决——那条链路面对"字面像但营养口径不同"的候选容易误判为同一种，导致修正静默失效），产出新估算食物条目并按新食物×原克数重算。修正后 `upsertFoodAlias(原食物名 → 新food_id)`（见 LEARNING_SPEC §7），下次同名食物直连命中修正版。
- 两者都只走已有 `record_card` + `undo{record_id, prev_state}` 老路，不新增卡片类型；`prev_state` 带上改前的精确 `calories/protein/fat/carbs/calories_source`，撤销直接还原这些值，不按 food×grams 重算（否则会丢失 `user_override` 的用户真值）。
- 纯口感/无关描述（"有点咸"、"挺好吃"）不算修正，不触发 `change.food_desc`，整体判 chat。

### 路由与确认（按破坏性分级，不一律弹卡）
| action | 置信 | 行为 |
|---|---|---|
| **delete** | 任意 | 建 `pending_record(type=delete_confirm)` → 确认卡（kind=`delete_confirm_card`）→ `/pending/:id/resolve` 后删 → 刷新 summary |
| **update** | 高 (>0.8) | **直接改 + 重算**，记录卡 payload 带 `undo{record_id, prev_state}` |
| **append** | 高 | **直接入库新记录** + 重算，卡带 `undo{record_id}` |
| update / append | 低 or 歧义 | 走现成 `portion_card` / `candidate_card`（§4），不新增卡 |

> 撤销不进 pending 流程：update 撤销 = 还原 `prev_state`，append 撤销 = 删新记录；给短时间窗即可。
> **只有 delete 需确认**；update/append 复用「自动入库 + 卡片」老路，避免打扰过头。

### 纯确认词处理
用户发极简确认词（「好」「改吧」「修改吧」「行」「ok」「确认」），若 L0 最近几轮的用户消息涉及对某条记录份量的讨论（如「不是50克吗」「应该是50g」），parser 推断 `target`（从 L1 找最近被讨论的 ref）和 `change.grams`（从讨论中提取数字），输出 `intent=modify, action=update`。推断不出具体 target 或克数则走 chat。

## 9. discuss 意图（质疑/追问已有记录，不动数据）

承接 §2。用户对 L1 里某条具体记录提问或质疑时用 `discuss`：
- 例：「为什么记成60克」「这个热量对吗」「这个份量怎么估的」
- parser 输出：`{"intent":"discuss","target":"r1"}`，`target` 引用 L1 `ref`
- 与 `query` 的区别：discuss 针对**某条具体记录**，query 是查今日**汇总数据**
- 与 `chat` 的区别：discuss 明确指向某条已有记录（从上下文推断）；推断不出则走 chat

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
