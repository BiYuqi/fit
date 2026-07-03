# T40 — 食物记录修正闭环：改热量 + 属性修正重估（对话智能）

**状态**：⬜待办

**目标**：用户对已入库食物的两种最自然的纠错表达能真正落地改数据：
1. **直接指定热量**："记录成180kcal"、"这个按150卡记"
2. **属性修正**："无油款"、"不是油煎的"、"是无糖的"、"去皮的" —— 影响营养口径，应重估

**依赖**：T28（intents 拆分）；建议排在 T37/T39 之后（双向记忆与只读路径红线先就位）
**关注文档**：AI_PARSING_SPEC §8、DATA_MODEL（food_record）、LEARNING_SPEC §3（信号对齐）、FOOD_DB_SPEC（估算条目）

## 背景（为什么会有这个任务，2026-07-03 真实案例）

用户 outoftoken：记了"100克葱花饼 煎的"（267kcal）→ 说"无油款"（被判 chat，AI 反问跑题）→ 解释"不是油煎的，热量算高了"（chat）→ 说"记录成180kcal"（被判 discuss 只读，AI 谎称"已更新"，DB 仍 267）→ 问"今晚都吃了啥"得到 267 当场穿帮 → 十分钟后"加80克鸡蛋葱花煎饼"又按油煎默认估。

**根因是协议缺口，不是模型笨**：`modify.change` 只有 `portion_label/grams/food/meal_type/calories_burned(仅运动)`——食物改热量、属性修正**无字段可表达**，AI 想执行也做不到，只能被挤进 chat/discuss。parser 提示词还明文把"补充修正描述"训练成 chat（本意防重复建记录），把"影响营养的修正"和"无关痛痒的口感描述"混为一谈。

## 设计要点（执行时可细化，方向不变）

- **铁律 1 辨析**：铁律禁的是 **AI 算账**。用户亲口给的数字（"180kcal"）是**用户真值**，后端直接落库不违反铁律；属性修正走重估时，AI 只产出每100g营养（复用 estimateByAI 路径），乘克数仍归后端。
- **协议扩展**（strict tool schema + zod 同构）：
  - `change.calories`：食物记录直接指定总热量（用户真值）。落库时按比例回推该记录的宏量素（或置 0/存疑标记，执行时定，DATA_MODEL 补字段语义；需要标记热量来源为 user_override，防止后续按 food×grams 重算时覆盖）。
  - `change.food_desc`：属性修正描述（如"无油"）。后端流程：新 canonical =「原食物名（无油）」级别的具体名 → matchFood（大概率无库条目）→ estimateByAI 产出估算条目 → 重算该记录。
- **parser 规则更新**：
  - "记录成X kcal / 按X卡记" → `modify.update` + `change.calories`（不再是 discuss）。
  - 影响营养口径的修正（无油/少油/无糖/去皮/脱脂）→ `modify.update` + `change.food_desc`；**纯口感/无关描述**（"有点咸"、"挺好吃"）才走 chat。现有"我没放糖→chat"的示例要改（放不放糖恰恰影响营养）。
- **与 T30 联动（自愈闭环）**：属性修正产生的估算条目（"葱花饼（无油）"）通过 user_food_alias 直连——用户下次再说"葱花饼"，streak≥2 后直接命中无油版，修正一次终身受益。
- **学习信号**：热量/属性修正写 learning_event（signal_type 对齐 LEARNING_SPEC §3，需要的话新增类型，规范同步）。
- **卡片**：复用 modify.update 老路——直接改 + record_card 带 undo（prev_state 还原），不新增卡片类型。
- AI_PARSING_SPEC §8 协议与路由表同步更新。

## 验收（以 2026-07-03 案例为回归脚本）

- "吃了100克葱花饼 煎的" → 入库 → "记录成180kcal" → 记录热量变 180、出带撤销的 record_card、summary 刷新；"今晚都吃了啥" → 回答 180。
- "无油款"（紧跟一条油煎口径的记录）→ 判为 modify 属性修正 → 重估落库、热量下降、record_card 带 undo。
- "有点咸"、"挺好吃的" → 仍走 chat，不动数据、不建新记录。
- 撤销：改热量/属性修正后点撤销 → 还原 prev_state。
- 属性修正后再次记录同名食物 → alias 直连命中修正后的条目（streak 满足时）。
- 单测：change.calories 与 change.food_desc 的 zod 校验、user_override 不被 recompute 覆盖、宏量素回推口径。
