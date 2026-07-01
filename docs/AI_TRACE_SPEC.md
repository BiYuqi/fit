# AI_TRACE_SPEC — AI 行为追踪与事件溯源

> 本文件定义"AI 在每一次用户输入中的行为如何被完整记录"。是一次架构级新增，与 `AI_PARSING_SPEC`（定义 AI 怎么解析）互补——前者管"怎么做"，本文件管"做了什么、为什么"。

## 1. 设计目标

> **完整记录 AI 在每一次用户输入中的真实行为轨迹。**

不是"让 AI 更聪明"，而是：

- **回放**：每一步发生了什么
- **调试**：定位 parse 错还是 normalize 错还是 decision 错
- **优化**：基于数据调 prompt / 阈值 / 默认值
- **进化**：基于用户修正自动改规则

## 2. 核心思想

> ❗ AI 不是黑盒输出，而是"事件流系统"。

每一次用户输入 = 一条"执行链路（Execution Trace）"。

```
User Input
   ↓
AI Execution Start → [ai_trace 创建]
   ↓
Parse Event         ← DeepSeek 理解成了什么
   ↓
Normalize Event     ← 匹配到哪个食物、走了哪条匹配路径
   ↓
Confidence Event    ← 置信度评估 + 判据
   ↓
Decision Event      ← 最终路由（自动入库 / 弹卡 / 追问）
   ↓
Output Event        ← 写入了什么记录
   ↓
Correction Event    ← 用户是否修正了 AI 的决策

任一环节可能触发：
Error Event         ← 链路断在哪一步、为什么
```

## 3. 名词定义

| 术语 | 定义 |
|------|------|
| **Trace** | 一次用户输入 → 最终产出的完整执行链路。一条 trace 包含多条 event。 |
| **Event** | trace 内的一步。每步记录 `state_before` / `state_after`（统一 envelope）和 `input_state` / `output_state`（event 特有 detail）。 |
| **Trace ID** | `ai_trace.id`，全链路唯一标识，贯穿 event 表、food_record.parse_log_id。 |
| **Item Index** | 一次输入可能产生多个食物记录（"吃了A和B"），每个 item 有独立的 normalize → decision → output 链。`item_index` 标记归属。 |
| **Session ID** | 轻量归组标签。一次连续聊天的多条 trace 共享同一个 session_id。不建 session 表、不建 FK、不管理生命周期。纯分析用。 |
| **Meal ID** | 轻量归组标签。同一餐的多条 trace（先记牛肉面，后追加蛋）共享同一个 meal_id。值为 `{date}_{meal_type}` 或类似。不建 FK，不建模餐次结构。 |

## 4. 数据模型

### 4.1 ai_trace — 执行链路主表

一次用户输入 = 一行。存**链路级别的聚合信息**和**发给 AI 的完整 prompt**。

```sql
CREATE TABLE ai_trace (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id),
  session_id        uuid,                               -- 轻量归组标签，不建 FK，不建 session 表
  meal_id           text,                               -- 轻量归组标签，{date}_{meal_type}，不建 FK
  input_text        text NOT NULL,                      -- 用户原始输入
  intent            text,                               -- record | query | chat | modify | discuss
  status            text NOT NULL DEFAULT 'started',    -- started | ok | partial | failed
  model_used        text,                               -- deepseek-v4-flash | deepseek-v4-pro
  model_upgraded    boolean DEFAULT false,              -- flash 失败后升到 pro？
  latency_ms        integer,                            -- 整条链路总耗时
  token_usage       jsonb,                              -- {prompt, completion, total}
  error_info        jsonb,                              -- status=failed 时的错误信息
  prompt_messages   jsonb,                              -- 完整的 messages 数组快照
  prompt_tools      jsonb,                              -- tools + tool_choice 快照（parse 调用有）
  prompt_hash       text,                               -- 静态 system prompt 的 SHA256 前 8 位（不含动态上下文）
  state_snapshot    jsonb,                              -- trace 创建时的结构化上下文快照（固定 schema，不是自由 dump）
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_trace_user ON ai_trace(user_id, created_at DESC);
CREATE INDEX idx_ai_trace_session ON ai_trace(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_ai_trace_meal ON ai_trace(user_id, meal_id) WHERE meal_id IS NOT NULL;
CREATE INDEX idx_ai_trace_prompt_hash ON ai_trace(prompt_hash);
```

**字段说明**：

- `session_id`：**轻量归组标签**，不建 session 表，不建 FK。一次连续聊天的多条 trace 共享同一个值。前端在 chat 页 mount 时生成一个 uuid，随每条消息发送。后端不管理生命周期。纯分析用——查"这次对话里发生了什么"时按它 group。
- `meal_id`：**轻量归组标签**，不建 FK，不建模餐次。值为 `{date}_{meal_type}`（如 `2026-07-01_lunch`），同一天同一餐的 trace 共享。AI 解析出 meal_type 后即可赋值。用途："这一餐用户交互了几轮？先后加了哪些食物？"
- `input_text`：冗余存储，方便查 trace 表时直接看到用户说了什么
- `state_snapshot`：**结构化上下文快照**，trace 创建时拍摄。有固定 schema，不是自由 jsonb dump。回放一条 trace 时，不需要跨表追查"当时的 profile 值、当天已吃了多少、这餐已有什么"。见 [§4.3 state_snapshot schema](#43-state_snapshot-schema)。
- `prompt_messages`：发给 DeepSeek 的完整 messages 数组的快照。是"可回放"的关键
- `prompt_tools`：tools 定义 + tool_choice 快照
- `prompt_hash`：**静态 system prompt 文本**（不含动态上下文 injection）的 SHA256 前 8 位 hex。用途：按 prompt 版本分组对比
- `model_upgraded`：flash 的 Zod 校验失败或 confidence < 0.5 时自动升 pro 重试，此字段记录是否发生了升级

### 4.2 ai_trace_event — 事件表

trace 内的每一步状态变迁。

```sql
CREATE TABLE ai_trace_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id        uuid NOT NULL REFERENCES ai_trace(id) ON DELETE CASCADE,
  item_index      integer,                           -- null = trace 级事件；0/1/2 = 第几个 item
  seq             integer NOT NULL,                  -- 同一 (trace_id, item_index) 内的顺序
  event_type      text NOT NULL,                     -- parse | normalize | confidence | decision | output | correction | error
  state_before    jsonb,                             -- 统一 envelope：变更前的公共状态（固定 key 集合）
  state_after     jsonb,                             -- 统一 envelope：变更后的公共状态（固定 key 集合）
  input_state     jsonb,                             -- event 特有 detail：进入时的完整上下文
  output_state    jsonb,                             -- event 特有 detail：产出的完整结果
  meta            jsonb,                             -- {duration_ms, reason, error_type, ...}
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_trace_event_trace ON ai_trace_event(trace_id, item_index, seq);
```

**`item_index` 的设计**：

- `null`：trace 级事件（parse），与具体 item 无关
- `0, 1, 2, ...`：第几个 item 的事件链

一条"吃了牛肉面和一杯豆浆"会产出两个 item，每个 item 有独立的 normalize → confidence → decision → output 链。`item_index` 让每个 item 的链可以独立抽取：

```sql
SELECT event_type, state_before, state_after, input_state, output_state, meta
FROM ai_trace_event
WHERE trace_id = $1 AND item_index = 0
ORDER BY seq;
```

### 4.3 state_snapshot — 结构化上下文快照

> ❗ 不是自由 jsonb dump。固定 schema，每次 trace 创建时拍摄。

`ai_trace.state_snapshot` 的 schema：

```json
{
  "meal_context": {
    "meal_type": "lunch",
    "existing_items": [
      {"ref": "r1", "name": "牛肉面", "weight_g": 450, "calories": 600}
    ],
    "existing_calories": 600
  },
  "daily_context": {
    "calories_in_so_far": 600,
    "remaining": 1000,
    "protein_so_far": 30,
    "target_protein": 110,
    "target_calories": 1600
  },
  "profile_snapshot": {
    "weight_kg": 75,
    "target_weight_kg": 70,
    "goal_type": "cut",
    "daily_deficit": 500
  }
}
```

数据来源是 `buildMemoryPack()` 的返回值——即当前喂给 AI 的上下文。和 `prompt_messages` 的区别：`prompt_messages` 是发给 AI 的**原始文本**（可读不可查），`state_snapshot` 是**结构化数据**（可直接在 SQL 里用 `jsonb` 操作符查询）。

用途：回放一条 trace 时，不需要跨 `daily_summary`、`food_record`、`users` 三张表去还原"当时的上下文是什么"。trace 自包含。

### 4.4 state_before / state_after — 统一 diff envelope

> ❗ 不是取代 input_state / output_state，而是在它们之外补充一个**可跨 event type 做 diff 的公共层**。

**问题**：7 种 event 的 input_state / output_state key 各不相同。parse 有 `{text, model}`，normalize 有 `{canonical, raw}`，decision 有 `{food_level, portion_level}`——你无法写一个通用查询做"找出 routing_action 发生变化的节点"。

**解法**：`state_before` 和 `state_after` 使用**同一组 key 集合**，当前 event 不涉及的 key 填 null：

| key | 类型 | 哪个 event 写入 |
|-----|------|----------------|
| `canonical` | text | normalize |
| `matched_food_id` | uuid | normalize |
| `matched_food_name` | text | normalize |
| `match_path` | text | normalize |
| `food_confidence` | float | parse → confidence |
| `portion_confidence` | float | parse → confidence |
| `is_ambiguous` | bool | parse → confidence |
| `calorie_spread` | float | normalize → confidence |
| `confidence_verdict` | text | confidence |
| `routing_action` | text | decision |
| `threshold_food_high` | float | confidence → decision |
| `threshold_portion_high` | float | confidence → decision |
| `record_id` | uuid | output |
| `pending_id` | uuid | output |
| `entity_type` | text | normalize |
| `entity_id` | uuid | normalize |

> `entity_type` + `entity_id` 提供跨 trace 的聚类分析能力。`entity_type` 为 `"food_standard"`，`entity_id` 为 `food_standard.id`。所有 normalize event 写入，其余 event 继承（state_before 拷贝上一条的 state_after）。这样就可以查"所有和鸡蛋相关的 trace 链"，不需要 join event 的 output_state。

一个 normalize event 的 state_before / state_after 例子：

```json
{
  "state_before": {
    "canonical": "煎饼",
    "matched_food_id": null,
    "matched_food_name": null,
    "match_path": null,
    "food_confidence": 0.62,
    "portion_confidence": 0.55,
    "is_ambiguous": false,
    "calorie_spread": null,
    "confidence_verdict": null,
    "routing_action": null,
    "threshold_food_high": null,
    "threshold_portion_high": null,
    "record_id": null,
    "pending_id": null,
    "entity_type": null,
    "entity_id": null
  },
  "state_after": {
    "canonical": "煎饼",
    "matched_food_id": "uuid-3012",
    "matched_food_name": "煎饼",
    "match_path": "prefix_true_spec",
    "food_confidence": 0.62,
    "portion_confidence": 0.55,
    "is_ambiguous": false,
    "calorie_spread": 45,
    "confidence_verdict": null,
    "routing_action": null,
    "threshold_food_high": null,
    "threshold_portion_high": null,
    "record_id": null,
    "pending_id": null,
    "entity_type": "food_standard",
    "entity_id": "uuid-3012"
  }
}
```

这一层的关键价值——跨 event type 的通用 diff 查询：

```sql
-- 找出所有 routing_action 发生变化的节点（跨 parse/decision/output）
SELECT trace_id, item_index, seq, event_type,
       state_before->>'routing_action' AS from,
       state_after->>'routing_action' AS to
FROM ai_trace_event
WHERE state_before->>'routing_action' IS DISTINCT FROM state_after->>'routing_action';
```

不需要知道 event_type，不需要分支逻辑。一条 SQL。

## 5. Event 类型定义

> 所有 event 都有两个数据层：
> - **`state_before` / `state_after`**：统一 envelope（key 集见 [§4.4](#44-state_before--state_after--统一-diff-envelope)），可跨 event type diff。当前 event 不涉及的 key 填 null。
> - **`input_state` / `output_state`**：event 特有 detail，key 因 event type 而异，不做统一。
>
> 以下只展示每种 event 的 `input_state` / `output_state` / `meta` 的 detail 结构。`state_before` / `state_after` 的通用 key 集不再在每个 event 中重复。

### 5.1 parse — 解析事件（trace 级，item_index=null, seq=0）

AI 理解成了什么。

```json
{
  "event_type": "parse",
  "item_index": null,
  "seq": 0,
  "input_state": {
    "text": "吃了一点煎饼",
    "model": "deepseek-v4-flash"
  },
  "output_state": {
    "intent": "record",
    "items": [
      {
        "raw": "一点煎饼",
        "canonical": "煎饼",
        "quantity_expr": "一点",
        "portions": [
          {"label": "small", "grams": 80},
          {"label": "medium", "grams": 120},
          {"label": "large", "grams": 180}
        ],
        "chosen_label": "medium",
        "food_confidence": 0.62,
        "portion_confidence": 0.55,
        "is_ambiguous": false
      }
    ]
  },
  "meta": {
    "duration_ms": 820,
    "model_upgraded_to_pro": false,
    "token_usage": {"prompt": 450, "completion": 120}
  }
}
```

> 这是 DeepSeek 返回的完整 `ParseResult`。当前存在 `ai_parse_log.parsed_json` 里，新体系下作为 event 存——parse 只是链路中的一步，不是全部。

### 5.2 normalize — 标准化事件（item 级）

食物名 → 数据库记录的映射过程。

```json
{
  "event_type": "normalize",
  "item_index": 0,
  "seq": 1,
  "input_state": {
    "canonical": "煎饼",
    "raw": "一点煎饼"
  },
  "output_state": {
    "match_path": "prefix_true_spec",
    "food_id": "uuid-3012",
    "food_name": "煎饼",
    "category": "小吃",
    "calories_100g": 233,
    "candidates_count": 3,
    "calorie_spread": 45,
    "adjudicated_by_ai": false
  },
  "meta": {
    "duration_ms": 3
  }
}
```

**`match_path` 枚举**（对应 `AI_PARSING_SPEC` §5 的匹配管线 7 步）：

| 值 | 含义 | 错误风险 |
|---|---|---|
| `exact_name` | 精确匹配 `food_standard.name` | 极低 |
| `alias` | 别名匹配 | 极低 |
| `prefix_true_spec` | 前缀真特化（name==canonical 或紧跟分隔符） | 低 |
| `prefix_suspect` | 可疑前缀撞词（如"蛋白"→"蛋白粉"而非"鸡蛋白"） | 高 |
| `pg_trgm` | 三元组模糊匹配（similarity ≥ 0.4） | 中 |
| `ai_adjudicate` | 有候选但 AI 裁决后选中 | 中 |
| `ai_estimate` | 无匹配，AI 直接估算营养 | 高 |

这是整个系统**最有调试价值的字段**——匹配路径直接决定数据质量。

### 5.3 confidence — 置信度事件（item 级）

为什么不直接入库？为什么弹卡？

```json
{
  "event_type": "confidence",
  "item_index": 0,
  "seq": 2,
  "input_state": {
    "food_confidence": 0.62,
    "portion_confidence": 0.55,
    "is_ambiguous": false,
    "calorie_spread": 45,
    "candidates_count": 3
  },
  "output_state": {
    "food_level": "medium",
    "portion_level": "low",
    "verdict": "portion_uncertain"
  },
  "meta": {
    "threshold_food_high": 0.8,
    "threshold_portion_high": 0.8,
    "threshold_food_low": 0.5,
    "calorie_spread_max": 100
  }
}
```

> 判决阈值存在 meta 里而非从代码推断——未来调阈值后，回放历史事件时你看到的是当时的阈值，不会用新标准误判旧数据。

### 5.4 decision — 决策事件（item 级）

最终路由到了哪里。

```json
{
  "event_type": "decision",
  "item_index": 0,
  "seq": 3,
  "input_state": {
    "food_level": "medium",
    "portion_level": "low",
    "is_ambiguous": false,
    "calorie_spread": 45
  },
  "output_state": {
    "action": "portion_card",
    "card_payload": {
      "food_name": "煎饼",
      "portions": [
        {"label": "small", "grams": 80, "calories": 186},
        {"label": "medium", "grams": 120, "calories": 280},
        {"label": "large", "grams": 180, "calories": 419}
      ]
    }
  },
  "meta": {
    "reason": "portion_confidence (0.55) < threshold (0.80)"
  }
}
```

**`action` 枚举**（对应 `AI_PARSING_SPEC` §4 的路由结果）：

| 值 | 含义 | 用户看到什么 |
|---|---|---|
| `auto_commit` | 食物高置信 + 份量高置信，直接入库 | record_card |
| `candidate_card` | 食物有歧义（is_ambiguous 或 calorie_spread > 100） | candidate_card，列出候选 |
| `portion_card` | 食物唯一但份量不确定 | portion_card，小/中/大选择 |
| `clarify_card` | 食物低置信（< 0.5），解析失败兜底 | clarify_card |

### 5.5 output — 输出事件（item 级）

写入了什么记录。

```json
{
  "event_type": "output",
  "item_index": 0,
  "seq": 4,
  "input_state": {
    "action": "portion_card"
  },
  "output_state": {
    "result": "pending_created",
    "pending_record_id": "uuid-pending-1",
    "record_id": null
  },
  "meta": {}
}
```

auto_commit 的情况：

```json
{
  "event_type": "output",
  "item_index": 0,
  "seq": 4,
  "input_state": {
    "action": "auto_commit"
  },
  "output_state": {
    "result": "record_created",
    "record_id": "uuid-food-record-1",
    "weight_g": 450,
    "calories": 600,
    "protein": 25,
    "fat": 12,
    "carbs": 80
  },
  "meta": {}
}
```

### 5.6 correction — 用户修正事件（item 级）

用户改变了 AI 的决策。最关键的闭环数据。

```json
{
  "event_type": "correction",
  "item_index": 0,
  "seq": 5,
  "input_state": {
    "source": "pending_resolve",
    "pending_id": "uuid-pending-1",
    "ai_guess": {
      "food_name": "煎饼",
      "portion_label": "medium",
      "grams": 120
    }
  },
  "output_state": {
    "user_chose": {
      "food_name": "煎饼",
      "portion_label": "large",
      "grams": 180,
      "food_id": "uuid-3012"
    }
  },
  "meta": {
    "correction_type": "portion_change",
    "grams_delta": 60,
    "calories_delta": 140
  }
}
```

modify 触发的 correction：

```json
{
  "event_type": "correction",
  "item_index": 0,
  "seq": 5,
  "input_state": {
    "source": "modify_update",
    "record_id": "uuid-food-record-1",
    "prev_state": {
      "portion_label": "medium",
      "grams": 450,
      "calories": 600
    }
  },
  "output_state": {
    "new_state": {
      "portion_label": "large",
      "grams": 600,
      "calories": 800
    }
  },
  "meta": {
    "correction_type": "portion_change",
    "confidence": 0.85,
    "action": "update"
  }
}
```

**`source` 枚举**：`pending_resolve`（用户从候选/份量卡中选择）| `modify_update`（用户说"改成大份"）| `modify_delete`（用户删了一条记录）

**`correction_type` 枚举**：`portion_change`（只改份量）| `food_change`（换了食物）| `delete`（删了记录）| `append`（追加了新食物）

### 5.7 error — 错误事件（trace 级或 item 级）

链路在某一节点断裂。

```json
{
  "event_type": "error",
  "item_index": 0,
  "seq": 3,
  "input_state": {
    "step": "decision",
    "action_about_to_take": "auto_commit"
  },
  "output_state": null,
  "meta": {
    "error_type": "db_error",
    "message": "connection timeout after 5000ms"
  }
}
```

**为什么需要独立 error event 而不是只用 `ai_trace.status=failed` + `error_info`？**

`ai_trace.error_info` 只能告诉你这整条 trace 失败了。error event 告诉你**断在哪一步、当时准备做什么**。事件流里的精确断点：

```
t1 / null / 0 / parse       → ok       ← DeepSeek 返回正常
t1 / 0    / 1 / normalize   → ok       ← 匹配成功
t1 / 0    / 2 / confidence  → ok       ← 判定完成
t1 / 0    / 3 / error       → DB 挂了  ← 断在这里
```

`error_type` 枚举：`deepseek_api`（API 错误/超时/限流）| `deepseek_format`（返回格式异常）| `zod_validation`（schema 校验失败）| `db_error`（数据库写入失败）| `internal`（代码异常）。

> trace 级别的 `status=failed` + `error_info` 是摘要，error event 是精确断点。两者互补，不互替。

### 6. 完整 Trace 示例

输入"吃了一点煎饼"后的完整数据：

```
ai_trace (id=t1):
  session_id: "sess-abc123"
  meal_id: "2026-07-01_lunch"
  input_text: "吃了一点煎饼"
  intent: "record"
  status: "ok"
  model_used: "deepseek-v4-flash"
  model_upgraded: false
  latency_ms: 830
  prompt_messages: [{system: "你是一个减脂App...", ...}, {system: "以下是当前对话上下文...", ...}, {user: "吃了一点煎饼"}]
  prompt_hash: "a1b2c3d4"
  state_snapshot: {meal_context: {meal_type: "lunch", existing_items: [...], existing_calories: 0}, daily_context: {...}, profile_snapshot: {...}}

ai_trace_event:
  t1 / null / 0 / parse      / sb:{} → sa:{canonical:"煎饼",food_confidence:0.62,...}    / input→output / {duration_ms:820}
  t1 / 0    / 1 / normalize  / sb:{matched_food_id:null} → sa:{matched_food_id:"uuid-3012",match_path:"prefix_true_spec"} / input→output / {duration_ms:3}
  t1 / 0    / 2 / confidence / sb:{confidence_verdict:null} → sa:{confidence_verdict:"portion_uncertain"} / input→output / {thresholds}
  t1 / 0    / 3 / decision   / sb:{routing_action:null} → sa:{routing_action:"portion_card"} / input→output / {reason}
  t1 / 0    / 4 / output     / sb:{record_id:null} → sa:{pending_id:"uuid-pending-1"} / input→output / {}
  t1 / 0    / 5 / correction / sb:{pending_id:"uuid-pending-1"} → sa:{record_id:"uuid-food-record-1"} / input→output / {deltas}
```

## 7. 埋点位置（精确到函数）

埋点在以下位置写入 event。**调用方只调 `recordEvent()`，不自己做开关判断。**

### 7.1 parse — chat.ts POST /api/chat/message，DeepSeek 返回后

```
位置：parseUserInput() 调用返回后，现有 ai_parse_log 写入之前
input_state：{ text: input, model: model_used }
output_state：完整的 ParseResult
```

### 7.2 normalize — processFoodItem()，matchFood 返回后

```
位置：matchFood() / matchFoodCandidates() 调用返回之后
input_state：{ canonical, raw }
output_state：{ match_path, food_id, food_name, category, calories_100g, candidates_count, calorie_spread, adjudicated_by_ai }
```

### 7.3 confidence — processFoodItem()，歧义/置信判定之后

```
位置：双信号 OR 判定（is_ambiguous || calorie_spread > 100）和置信阈值判定之后
input_state：{ food_confidence, portion_confidence, is_ambiguous, calorie_spread, candidates_count }
output_state：{ food_level, portion_level, verdict }
meta：{ threshold_food_high, threshold_portion_high, threshold_food_low, calorie_spread_max }
```

### 7.4 decision — processFoodItem()，路由分支之后

```
位置：auto_commit / candidate_card / portion_card / clarify_card 分支选择之后
input_state：{ food_level, portion_level, is_ambiguous, calorie_spread }
output_state：{ action, card_payload }
meta：{ reason }
```

### 7.5 output — processFoodItem()，写库之后

```
位置：food_record 创建或 pending_record 创建之后
input_state：{ action }
output_state：{ result, record_id?, pending_record_id?, 营养值? }
```

### 7.6 correction — 两处

**A. pending resolve（POST /pending/:id/resolve）**

```
位置：pending 状态更新为 resolved 之后
input_state：{ source: "pending_resolve", pending_id, ai_guess }
output_state：{ user_chose }
meta：{ correction_type, grams_delta, calories_delta }
```

**B. modify 高置信直执行（chat.ts modify 处理分支）**

```
位置：update/delete/append 执行之后
input_state：{ source, record_id, prev_state }
output_state：{ new_state }
meta：{ correction_type, confidence, action }
```

### 7.7 链路闭合

- `food_record.parse_log_id = trace_id`：在 food_record 创建时写入（修复当前永为 null 的断链）
- `ai_trace.status`：从 `started` → `ok`（正常完成）/ `partial`（部分成功）/ `failed`（异常）
- `ai_trace.latency_ms`：整条链路计时（`Date.now() - startTime`）

## 8. 控制模型（三层开关）

> 开关逻辑集中在 `backend/src/ai/trace.ts`，调用方无感。

### 8.1 环境变量

```bash
AI_TRACE=enabled          # enabled | minimal | disabled
AI_TRACE_EVENTS=all       # all | parse,normalize,confidence,decision,output,correction,error（逗号分隔）
AI_TRACE_SAMPLE_RATE=1.0  # 0.0 ~ 1.0
```

### 8.2 层级行为

| 层级 | 变量 | 行为 |
|---|---|---|
| L1 总开关 | `AI_TRACE` | `disabled`：零开销，不建 trace、不写 event。<br>`minimal`：只建 trace 头 + parse event，不存 prompt_messages，不写其余 event。<br>`enabled`：完整记录 |
| L2 事件类型 | `AI_TRACE_EVENTS` | 仅 `enabled` 时生效。`all` 全记；逗号分隔的列表只记指定类型 |
| L3 采样率 | `AI_TRACE_SAMPLE_RATE` | 仅 `enabled` 时生效。`1.0` 全记；`0.1` 随机记 10% |

### 8.3 判断顺序

```
AI_TRACE === 'disabled'  →  直接返回，后续全部跳过
AI_TRACE === 'minimal'   →  只记 trace 行 + parse event
AI_TRACE === 'enabled'   →  按 AI_TRACE_EVENTS 过滤 → 按 SAMPLE_RATE 采样 → 写入
```

### 8.4 场景预设

| 场景 | AI_TRACE | AI_TRACE_EVENTS | SAMPLE_RATE |
|---|---|---|---|
| 本地开发调试 | `enabled` | `all` | `1.0` |
| 调 prompt 回归测试 | `enabled` | `parse,decision` | `1.0` |
| 查匹配管线 bug | `enabled` | `normalize,confidence,decision,correction` | `1.0` |
| 生产环境降级 | `minimal` | — | `1.0` |
| 生产环境采样观测 | `enabled` | `all` | `0.05` |
| 完全关闭 | `disabled` | — | — |

## 9. 聚合查询（调试与运维）

### 9.1 回放单条 trace

```sql
SELECT event_type, item_index, seq,
       jsonb_pretty(input_state) AS input,
       jsonb_pretty(output_state) AS output,
       jsonb_pretty(meta) AS meta
FROM ai_trace_event
WHERE trace_id = $1
ORDER BY item_index NULLS FIRST, seq;
```

### 9.2 查所有 AI 估算的匹配（最高风险）

```sql
SELECT t.input_text, t.created_at,
       e.output_state->>'canonical' AS canonical,
       e.output_state->>'match_path' AS path
FROM ai_trace_event e
JOIN ai_trace t ON e.trace_id = t.id
WHERE e.event_type = 'normalize'
  AND e.output_state->>'match_path' = 'ai_estimate'
ORDER BY t.created_at DESC;
```

### 9.3 按 prompt 版本对比效果

```sql
SELECT prompt_hash,
       count(*) AS traces,
       count(*) FILTER (WHERE status = 'failed') AS failures,
       avg(latency_ms)::int AS avg_latency_ms,
       avg((token_usage->>'total')::int)::int AS avg_tokens
FROM ai_trace
WHERE created_at > now() - interval '7 days'
GROUP BY prompt_hash
ORDER BY traces DESC;
```

### 9.4 用户修正热力图（哪些食物被改得最多）

```sql
SELECT e.output_state->'user_chose'->>'food_name' AS food_name,
       count(*) AS corrections,
       round(avg(abs((e.meta->>'grams_delta')::numeric)))::int AS avg_grams_change,
       round(avg(abs((e.meta->>'calories_delta')::numeric)))::int AS avg_cal_change
FROM ai_trace_event e
WHERE e.event_type = 'correction'
  AND e.meta->>'correction_type' = 'portion_change'
GROUP BY e.output_state->'user_chose'->>'food_name'
ORDER BY corrections DESC;
```

### 9.5 什么场景最容易弹 candidate_card

```sql
SELECT t.input_text, e.meta->>'reason' AS reason
FROM ai_trace_event e
JOIN ai_trace t ON e.trace_id = t.id
WHERE e.event_type = 'decision'
  AND e.output_state->>'action' = 'candidate_card'
ORDER BY t.created_at DESC
LIMIT 20;
```

### 9.6 按食物聚类分析（entity 维度）

```sql
-- 哪些食物最容易触发 correction？平均被改了多少克？
SELECT e.state_after->>'matched_food_name' AS food_name,
       count(DISTINCT e.trace_id) AS traces,
       count(*) FILTER (WHERE c.event_type = 'correction') AS corrections,
       round(avg(abs((c.meta->>'grams_delta')::numeric)))::int AS avg_grams_change
FROM ai_trace_event e
LEFT JOIN ai_trace_event c
  ON c.trace_id = e.trace_id
 AND c.item_index = e.item_index
 AND c.event_type = 'correction'
WHERE e.event_type = 'normalize'
  AND e.state_after->>'entity_type' = 'food_standard'
GROUP BY e.state_after->>'matched_food_name'
ORDER BY corrections DESC
LIMIT 20;
```

### 9.7 解析失败率趋势

```sql
SELECT date(created_at) AS day,
       count(*) AS total,
       count(*) FILTER (WHERE status = 'failed') AS failed,
       count(*) FILTER (WHERE model_upgraded = true) AS upgraded_to_pro
FROM ai_trace
WHERE created_at > now() - interval '14 days'
GROUP BY day
ORDER BY day;
```

## 10. 与现有表的关系统

### 10.1 ai_parse_log（现有）

**保留不删，历史数据不动，也不迁移。** 旧数据只有 `input_text` + `parsed_json` 最终 blob，缺少 normalize / decision / correction 链路——半条 trace 比没有更误导人。新代码不再写此表，完全切到 `ai_trace` + `ai_trace_event`。

### 10.2 pending_record（现有）

保持现有逻辑，改动点：
- resolve 时查找原 trace 写 correction event
- trace 链路：`ai_trace → ai_trace_event(decision, action=pending) → pending_record → ai_trace_event(correction)`

### 10.3 food_record（现有）

改动点：
- `parse_log_id`：从永为 null → 写入 trace_id（链路闭合）
- 已有字段（food_confidence, portion_confidence, raw_input）保持不变

### 10.4 chat_message（现有）

不动。chat_message 是展示层（显示气泡/卡片），trace 是调试层（记录 AI 行为）。两者不同职责，互不干扰。

## 11. trace 与优化系统的边界

> trace 系统管"记录"，不管"优化"。但 trace 数据是优化系统的输入。本节定义两者的契约。

### 11.1 职责边界

```
┌─────────────────────────────────────────────────────┐
│ trace 系统（本文件范围）                              │
│                                                     │
│  ✔ 记录每一步 event                                  │
│  ✔ 记录用户修正（correction event）                   │
│  ✔ 提供聚合查询（§9）                                │
│  ✘ 不自动修改默认值                                  │
│  ✘ 不自动调阈值                                      │
│  ✘ 不自动改 prompt                                   │
│                                                     │
└────────────────────┬────────────────────────────────┘
                     │ correction 数据
                     ▼
┌─────────────────────────────────────────────────────┐
│ 优化系统（独立工程，不在本文档范围）                    │
│                                                     │
│  - 读 correction event 聚合                          │
│  - 发现模式（"鸡蛋中份被用户改大了 80%"）              │
│  - 输出优化建议或自动执行                              │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 11.2 trace → 优化系统的数据契约

trace 系统对外暴露以下查询接口，优化系统消费它们。**这些查询是接口契约，trace schema 变更时需保持兼容。**

#### 接口 A：份量偏差排行

```sql
-- 哪些食物、哪种份量最常被用户修正？改了多少克？
SELECT e.state_after->>'matched_food_name' AS food_name,
       e.state_before->>'portion_label' AS ai_guess_label,
       e.state_after->>'portion_label' AS user_chose_label,
       count(*) AS corrections,
       round(avg(abs((e.meta->>'grams_delta')::numeric)))::int AS avg_grams_change
FROM ai_trace_event e
WHERE e.event_type = 'correction'
  AND e.meta->>'correction_type' = 'portion_change'
GROUP BY 1, 2, 3
ORDER BY corrections DESC;
```

→ 优化动作：调高该食物在 AI prompt 里的默认份量克数，或调 portion_confidence 默认值。

#### 接口 B：匹配路径错误率

```sql
-- normalize 走了哪条匹配路径后，用户最容易改掉这个食物？
SELECT e.state_after->>'match_path' AS match_path,
       count(*) AS total,
       count(*) FILTER (WHERE c.event_type = 'correction'
                         AND c.meta->>'correction_type' = 'food_change') AS food_corrected,
       round(100.0 * count(*) FILTER (WHERE c.event_type = 'correction'
         AND c.meta->>'correction_type' = 'food_change') / count(*), 1) AS error_rate_pct
FROM ai_trace_event e
LEFT JOIN ai_trace_event c ON c.trace_id = e.trace_id AND c.item_index = e.item_index AND c.event_type = 'correction'
WHERE e.event_type = 'normalize'
GROUP BY 1
ORDER BY total DESC;
```

→ 优化动作：如果 `ai_estimate` 的 error_rate 显著高于 `exact_name`，说明 AI 估算不准，需要扩充食物库或改进 canonical 生成规则。

#### 接口 C：路由决策合理性

```sql
-- 弹了 portion_card 之后，用户有多大概率选了和 AI 猜测不一样的份量？
SELECT e.state_after->>'routing_action' AS action,
       count(*) AS total,
       count(*) FILTER (WHERE c.meta->>'correction_type' = 'portion_change') AS corrected,
       round(100.0 * count(*) FILTER (WHERE c.meta->>'correction_type' = 'portion_change') / count(*), 1) AS correction_rate_pct
FROM ai_trace_event e
LEFT JOIN ai_trace_event c ON c.trace_id = e.trace_id AND c.item_index = e.item_index AND c.event_type = 'correction'
WHERE e.event_type = 'decision'
GROUP BY 1;
```

→ 优化动作：如果 `portion_card` 的 correction_rate 远高于 `auto_commit`，说明阈值 0.8 太松，应调高；反之如果 `auto_commit` 的 correction_rate 也很高，说明阈值太严，该放松。

### 11.3 不做的事（明确排除）

- ❌ trace 系统不自动执行优化
- ❌ trace 系统不维护 rule 版本号
- ❌ 优化建议不通过 trace 表返回——另建 `optimization_log` 或人工 review
- ❌ 不做实时（online）优化——优化是离线（offline）批处理

## 12. 实现阶段

### Phase 1：建表 + parse + trace 头

- 建 `ai_trace` + `ai_trace_event` 表（migration）
- 实现 `backend/src/ai/trace.ts`（开关模块 + recordEvent）
- 在 `POST /chat/message` 中：创建 trace 行 → parse 后写 parse event
- `food_record.parse_log_id` 写入 trace_id（修复断链）

### Phase 2：normalize + confidence + decision + output

- 在 `processFoodItem()` 的 4 个关键节点埋 normalize / confidence / decision / output event
- **这是核心——从这里起每个 item 的完整处理链路完全可见**

### Phase 3：correction 闭环

- pending resolve 写 correction event
- modify update/delete 写 correction event
- 实现聚合分析查询

### Phase 4：query/chat/modify/discuss intent 事件化

- 非 record intent 的处理过程也纳入 trace + event 体系

## 13. 存储估算

以"一天 100 条用户输入"的活跃使用量计算：

| 数据 | 单条约 | 日均 | 年 |
|---|---|---|---|
| `ai_trace`（含 prompt_messages + state_snapshot） | ~10 KB | ~1 MB | ~360 MB |
| `ai_trace_event`（平均 5 event/条，含 state_before/state_after） | ~4 KB | ~400 KB | ~140 MB |
| **合计** | ~14 KB | ~1.4 MB | ~500 MB |

> 对于个人 App，此量级完全在 Postgres 的舒适区内，无需额外存储策略。

如需更低存储开销，可通过 `AI_TRACE=minimal`（只记 trace 头，不存 prompt_messages 和细分 event）或调低 `AI_TRACE_SAMPLE_RATE` 实现。

## 14. 设计原则

1. **所有行为必须事件化**：不能有隐式逻辑，每一步可追溯
2. **AI 不直接输出结果，而是输出 event 链**：parse 只是第一步
3. **所有错误必须可追溯到 event 节点**：match_path、confidence verdict、decision reason，以及 error event 的精确断点
4. **所有修正必须能反推影响链**：correction 关联回原 trace + item
5. **阈值与时间必须快照化**：prompt 内容、置信阈值、用户 profile、state_snapshot——「当时是什么就是什么」，不与当前值混淆
6. **开关集中管理，调用方无感**：业务代码只调 `recordEvent()`，不做 if 判断
7. **语义标签，不建语义系统**：session_id / meal_id 是轻量归组标签（nullable，无 FK，无独立表），不是结构性建模。trace 不做业务逻辑
8. **快照结构化，不做自由 dump**：state_snapshot、state_before / state_after 有固定 key 集合，不随 event type ad-hoc 变化
9. **trace 只记录，不优化**：correction 数据供外部消费（§11），trace 系统本身不执行自动修正、不调参数、不改规则
