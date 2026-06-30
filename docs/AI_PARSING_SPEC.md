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
每条消息先判：`record`（记录饮食/运动）/ `query`（查数据）/ `chat`（闲聊/营养问题）/ `modify`（改/删/追加已有记录，见 §8）。可与解析在同一次调用完成。

## 3. record 解析协议
DeepSeek 输出（strict tool schema，zod 同构校验）：
```json
{
  "intent": "record",
  "meal_type": "lunch",
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
- `portions`：每份量的克数估算（数据库不存克数，全由此估）。
- `is_ambiguous`：AI 语义判断食物名是否有歧义（如"煎饼"可指多种，"粥"可指多种）。
- 运动则输出 `{type, duration_min, intensity?}`，热量后端按 MET 估或简表。

## 4. 歧义判定与路由规则

歧义判定采用**双信号 OR**，任一为真即走 CandidateCard：
- `is_ambiguous = true`（AI 语义判断）
- DB 候选热量离散度 `calorie_spread > 100 kcal/100g`（matchFoodCandidates 返回）

| 判定结果 | 行为 |
|---|---|
| 歧义（双信号任一为真） | CandidateCard：列出候选食物，每项显示默认中份热量，点击直接录入食物+份量，再点展开小/中/大换份量 |
| 不歧义 + 食物高 + 份量高 (>0.8) | 自动入库，直接反馈 record_card |
| 不歧义 + 份量不确定 | PortionCard：份量给 小/中/大（含热量）让用户选 |
| 食物低置信 (<0.5) | clarify_card（极少见，是解析失败兜底） |

每张食物最多问一次（食物歧义优先于份量歧义），resolve 后不再追问份量。
中/低置信生成 `pending_record`，前端出对应卡片，用户选择后走 `/pending/:id/resolve`。

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
  4. pg_trgm（≥0.4）命中 → 也进"可疑候选"
  5. 无任何候选 → DeepSeek 估营养 → 落库 is_estimated=true
  6. 有可疑候选 → 回灌 DeepSeek 裁决（带用户原话 raw + 候选名/类目/热量）：
       · 类目仅作判断信息，不硬排除（category 取自文件名，粗，不给一票否决）
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
  "today":  {"in":1320,"out":1900,"deficit":580,"p":70,"f":40,"c":150,"remaining":580},
  "week":   {"avg_deficit":-450,"logged_days":6},
  "month":  {"logged_days":23,"avg_in":1400},
  "targets":{"calories":1600,"protein":110}
}
```
`query` 意图直接用此卡回答，**不必每轮查库**。

> 区分：**显示用全量聊天记录（chat_message），喂 AI 用「对话记忆包」（§7）**。两者不同，别混。上下文卡是记忆包里的 L2 聚合层。

## 7. 对话记忆包（无状态 API 的上下文拼装）

> DeepSeek 无状态（§1）：每轮把下面**三层一起拼进请求**，让 AI「不丢上下文、不显得愚蠢」。三层分工不可混。
> **铁律 3 延伸**：`chat_message` 是展示层，**绝不喂 AI**。对话记忆从 `ai_parse_log`(+join `food_record`) 抽，不从 `chat_message` 取。

| 层 | 内容 | 解决 | 来源 | 取多少 |
|---|---|---|---|---|
| **L2 画像·永久** | `user_profile` + 上下文卡（§6） | 「懂我」：体重/目标/缺口/剩余额度 | `users` + `daily_summary` | 固定，永久在场 |
| **L1 工作记忆·今天** | `recent_records`：今天每条记录的**当前值快照** + `ref` | 「A 是哪一行、现在多少克/卡」 | `food_record` / `exercise_record`（今天） | 今天全部（通常 <15 条） |
| **L0 对话窗口·最近** | `recent_turns`：最近几轮「用户说了啥 + AI 做了啥动作」的结构化摘要 | 指代与时序：「那个」「再加」「不对我说中份」 | `ai_parse_log`(+join `food_record`) | 最近 6~8 轮，**滑动窗口** |

L1 句柄（`ref` 供 L0 与 §8 modify 的 `target` 引用）：
```json
"recent_records":[
  {"ref":"r1","record_id":"uuid-a","name":"牛肉面","meal_type":"lunch","portion":"medium","weight_g":450,"calories":600},
  {"ref":"r2","record_id":"uuid-b","name":"鸡蛋","meal_type":"breakfast","weight_g":50,"calories":72}
]
```

L0 摘要（**去卡片 payload、去闲聊长文本**，只留意图 + 动作锚点，否则上下文变吵）：
```json
"recent_turns":[
  {"said":"早餐吃了牛肉面","act":"record","ref":"r1","food":"牛肉面","portion":"medium"},
  {"said":"那个改成小份","act":"modify.update","ref":"r1","to":{"portion":"small"}},
  {"said":"蛋白质够吗?","act":"query"}
]
```

> **滑动窗口**：L0 只取最近 6~8 轮，更老丢弃——「记得几段、再远就忘」。L1 是事实快照不是对话，今天全留。

## 8. modify 意图：指代修改（改 / 删 / 追加）

承接 §2。`modify` **不由 AI 算账**——AI 只产出「改哪条 + 怎么改」，`target` 引用 §7 `recent_records.ref`；后端重新匹配 + 重算（calc）。

`action` 三选一：
- **update**：改已有记录的份量/食物。如「牛肉面换大份」「不对，是牛肉拉面」
- **delete**：删一条。如「早餐那个蛋删了」
- **append**：在 `target` 所属**那一餐里新增**记录（继承 `meal_type`/时段），新项走正常匹配 + 份量流程。如「早餐再加个蛋」

> `append` 与 `update` 的界：「牛肉面再加点」=同食物加量(update)；「早餐再加个蛋」=新项(append)。由 `action` 区分。

协议（strict tool schema + zod 同构）：
```json
{"intent":"modify","action":"update","target":"r1","change":{"portion_label":"large"}}
{"intent":"modify","action":"append","target":"r1","items":[ /* 蛋,结构同 §3 items */ ]}
{"intent":"modify","action":"delete","target":"r1"}
```

### 路由与确认（按破坏性分级，不一律弹卡）
| action | 置信 | 行为 |
|---|---|---|
| **delete** | 任意 | 建 `pending_record(type=delete_confirm)` → 确认卡（kind=`delete_confirm_card`）→ `/pending/:id/resolve` 后删 → 刷新 summary |
| **update** | 高 (>0.8) | **直接改 + 重算**，记录卡 payload 带 `undo{record_id, prev_state}` |
| **append** | 高 | **直接入库新记录** + 重算，卡带 `undo{record_id}` |
| update / append | 低 or 歧义 | 走现成 `portion_card` / `candidate_card`（§4），不新增卡 |

> 撤销不进 pending 流程：update 撤销 = 还原 `prev_state`，append 撤销 = 删新记录；给短时间窗即可。
> **只有 delete 需确认**；update/append 复用「自动入库 + 卡片」老路，避免打扰过头。
