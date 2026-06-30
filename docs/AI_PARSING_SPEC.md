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
每条消息先判：`record`（记录饮食/运动）/ `query`（查数据）/ `chat`（闲聊/营养问题）。可与解析在同一次调用完成。

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
- `canonical`：归一后的标准食物名，供匹配。
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

## 5. 食物匹配管线（无 embedding）
```
matchFoodCandidates（歧义检测）：
  1. 精确匹配 food_standard.name
  2. alias 匹配
  3. 前缀匹配 name LIKE 'query%'（捕获泛称→具体变体，如"煎饼"→煎饼果子）
  4. pg_trgm 模糊匹配（similarity ≥ 0.4）
  5. 四路结果去重合并，返回候选列表 + calorie_spread（所有候选热量极差）

matchFood（单一最佳匹配，含兜底）：
  1-4. 同上，取最高相似度
  5. 仍失败 → DeepSeek 估三大营养素 → 落库 is_estimated=true → 用之
```
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

> 区分：**显示用全量聊天记录（chat_message），喂 AI 只用压缩上下文卡 + 最近一两轮**（处理"再加点"这类指代）。两者不同，别混。
