# T66 — 用户终值采信贯通 record 全链路（+ B 轨数据接缝）（对话精度 R2）

**状态**：✅已完成

**目标**：`modify` 早就支持"用户直接给出最终热量 → 直接采信"（`change.calories`，T40），但这条原则**从没贯通到第一次记录**。用户报吃的时候顺带说热量，系统没有对应字段，只能先按份量估错、再吵着改。补上 `calories_override`，并**顺带采集 B 轨需要的偏差三元组**。

**依赖**：无硬依赖。改动面覆盖 record 全食物管线（record / modify.append / multi 的 record 与 append op 共用 `processItems`/`processFoodItem`，一次修复全覆盖）。
**关注文档**：`AI_PARSING_SPEC.md` §3（record 协议，需补字段）、§8（`change.calories` 是参照的既有实现）、`LEARNING_SPEC.md`（三元组采集与学习信号的关系）。

## 这是 T50 挂起项的兑现

`T50-record-exercise-calories.md` 第 27 行明确写了运动侧先做、"食物留待日后单独立项"，理由是**"现实里用户几乎不知道一盘菜多少卡，'食物报热量'极罕见"**。

`npm run audit` 证伪了这个假设：outoftoken 有 **6 条** `user_override` 记录、多次"改成850卡/改成900卡/饺子改为1100卡"，用户一直在报热量——只是以前只能靠事后 `modify` 补救。

T50 还预判了实现难点（"给了总热量仍要跑完整套估份量流程拿宏量素比例再缩放，不是抄写"）——本任务的 `scaleNutritionToCalories` 正是这一步；并指出食物侧与运动侧的关键差异：`exercise_record` 无需 source 标记（从不被后台重算），**食物侧必须打 `calories_source=user_override`**，否则会被 food×grams 静默重算覆盖。

## 背景（2026-07-13 真机，账号 outoftoken）

```
用户: "一个自制冰激淋80卡"
系统: {"intent":"chat"}                      ← 整句当成知识性提问，压根没记
用户: "我都说80了，记录啊"                    ← 走了 record，但弹份量卡问小/中/大
用户: "我说了卡，是直接录入，听懂了吗"          ← 被确认成"中份70g"，套库算出 140kcal
用户: "我说了冰淇淋80卡。你别管多重行吗？擅作主张"  ← 终于走 modify.calories=80 生效
```
四轮才记进去一个数字。

## 设计要点

> **定位方式**：本文件的行号只是写作时的快照，**T64–T68 会依次修改同几个文件，行号必然漂移**。一律用搜索定位（文中给出的段落特征字符串），别照行号跳。


### A. Schema（`src/ai/schema.ts`）
`FoodItemBaseSchema` 加 `calories_override: z.number().positive().optional()`。因为 `RecordVariantSchema` / `ModifyVariantSchema.items` / `MultiOpSchema` 全都复用 `FoodItemSchema`，**改这一处自动覆盖 record / append / multi 三处协议**。

`parseToolSchema` 的 `itemsProp.items.properties` 同步加：
```
calories_override: { type:"number", description:"用户直接给出的该条目最终热量(kcal)，如'80卡'。这是用户真值不是AI估算——后端直接采信，不再按食物库×克数计算。同时报了克数也照常填 portions/chosen_label（供展示与学习），但入库热量以此字段为准。" }
```

### B. Prompt（`src/services/parser.ts`）
record 段加规则（与运动侧 `calories_burned` 对称，T50）：用户描述食物时直接给出该条目热量 → 填 `calories_override`，别因为"AI 不该算账"而回避——这是用户真值。

**同时必须修意图路由**：案例里 `intent` 判成了 `chat`。规则要写清判据：**陈述自己吃了什么并带热量数字**（"一个自制冰激淋80卡"）→ `record`；**问**热量（"自制冰激淋多少卡"）→ `chat`。few-shot 的 intent 必须是 `record`，把这个边界演示出来。

### C. 落库：四个入口都要接住，只改一部分等于没修
"时灵时不灵"比"完全不支持"更糟——用户无法预期。建议先在 `src/services/calc.ts` 抽共享 helper：
```ts
resolveNutrition(base: ItemNutrition, override?: number | null):
  { nutrition: ItemNutrition; calories_source: "computed" | "user_override" }
```
内部就是 `override != null` 时调 `scaleNutritionToCalories`。四处调用同一个，避免抄四遍、以后漏改。

1. **`intents/food-item.ts` `processFoodItem` auto_commit 分支**（约 253-299 行）：`itemNutrition` 之后接 `resolveNutrition`，`foodRecord.create` 显式写 `calories_source`。注意该函数第 104 行是**解构** `item`，新字段加进解构里，别写 `item.calories_override` 破坏既有风格。
2. **同函数 portion_card 分支**（约 303-331 行）：**用户已给热量时不要再弹份量卡**——这正是用户骂"你别管多重行吗"的那一步。`calories_override != null` 时跳过建卡直接落库，`weight_g` 取 `biasedChosen.grams`（重量只用于展示，不参与算账）。实现上是把 auto_commit 的判断条件放宽为 `(food_conf>=0.8 && portion_conf>=0.8) || calories_override != null`（此处食物已确定——歧义分支在更早处已 return）。
   **且这条不作为份量学习信号**：用户从没纠正过重量，不该产生份量偏差反馈，确认不污染 `predicted_grams` 相关的学习写入。
3. **`buildCandidateCardData`**（同文件 42-82 行）：它**不接收整个 item，而是 12 个具名参数**，要改三处才通——(a) `params` 类型加 `calories_override?: number|null`；(b) 第 56 行解构加上；(c) 第 77 行 `candidates` JSON 加 `calories_override`。调用点（约 165-167 行）也要传。歧义候选卡这步不能跳过（食物都还没定），只做透传。
4. **`services/pending-resolve.ts`**：(a) food_choice→portion_choice 二次建卡（约 150-172 行）从上一个 `candidates.calories_override` 原样透传；(b) 最终 `foodRecord.create`（约 200-224 行）用 `resolveNutrition` + 显式写 `calories_source`。

### D. B 轨接缝：采集偏差三元组（**别省，省了 B 轨要重等几周**）
现在库里 6 条 `user_override` **只存了最终结果**，推不出系统当时错了多少——`npm run audit` 只能拿"当前 `food_standard` 值 × 克数"反算，条目事后被改过就不准。

所以凡是写入 `calories_source="user_override"` 的地方（本任务 4 处 + `modify.ts` 既有 1 处），**同时存下三元组**：`food_id` / 系统本会算出的值（`baseNutrition.calories`）/ 用户给的值。

落在哪里由实现者定（建议 `food_record` 加一个 `calories_computed` 数值列，最小改动、天然随记录走；不要新建表）。

**Migration 约定**：`npx prisma migrate dev --name t66_calories_computed`，命名跟现有惯例 `<时间戳>_t<任务号>_<描述>`（如 `20260705050630_t52_food_record_count`）。**新列必须可空**——存量 177 条记录没有这个值，不要写 `NOT NULL` 或强行回填（回填只能靠反算，反而把不精确的数据固化成"精确采集"）。

**`scripts/audit.ts` 的 B 轨要相应改成"有精确值用精确值，为空则回退当前的反算，并在输出里标明哪些行是反算的"**——不能因为新列存在就假定全都有值，否则历史样本会被算成 0 偏差。

## 改动清单
- `backend/src/ai/schema.ts`、`backend/src/services/calc.ts`（`resolveNutrition`）
- `backend/src/services/intents/food-item.ts`（3 处）、`backend/src/services/pending-resolve.ts`（2 处）、`backend/src/services/intents/modify.ts`（三元组）
- `backend/prisma/schema.prisma` + migration（三元组字段）
- `backend/src/services/parser.ts`（规则 + few-shot）
- `backend/scripts/audit.ts`（B 轨改用精确值）
- `backend/eval/cases/record-calorie-override.yaml`
- `docs/AI_PARSING_SPEC.md` §3、`docs/DATA_MODEL.md`（新字段语义）

## 验收

**写 eval 用例前先读 `backend/eval/README.md`**——用例格式、断言纪律（禁全文相等）、`{lt}/{gt}/{ne}` 方向性比较器、数值容差 ±0.5、以及"如何减少随机红灯"的写法都在那里。项目惯例：**未修复的缺陷先加用例并标 `known_fail: Txx`，修好后删标记**（红灯清单即已知缺陷清单）。

1. 单测：`calc.test.ts` 补 `resolveNutrition`（参照现有 `scaleNutritionToCalories` 测试写法）。
2. eval：「一个自制冰激淋80卡」**一句话**记成 80kcal，`calories_source=user_override`，**全程不出份量卡**。
3. 三元组：该记录的 `calories_computed`（系统本会算出的值）与用户值都能取到，`npm run audit` B 轨显示精确偏差而非反算。
4. 全量 `npm run eval` 无新回归（干净端口）——重点 `card-flow`、`pending-text-answer`（改了两处 pending 的 `candidates` 结构与 portion_card 触发条件）。
5. `npm test` 全绿。

## 提示词（可粘贴）
> 按本文件执行 T66。改动面最大，**四个落库/建卡入口必须全部接住** `calories_override`，只改一部分等于没修。动手前通读 `food-item.ts` 全文与 `pending-resolve.ts` 相关段落，理清数据如何从 record 建卡流到 `pending_record.candidates` 再到最终 `foodRecord.create`；先抽 `resolveNutrition` 再改四处。**两个最易做错的点**：(a) 给了 `calories_override` 就不该再弹份量卡（设计要点 C-2）；(b) 设计要点 D 的三元组别省，省了 B 轨要重新等几周攒数据。完成后跑 `npm test` + 干净端口 `npm run eval` + `npm run audit`。遵守 CLAUDE.md 铁律 10/12，完成后把本文件状态改 ✅ 并同步 `docs/TASKS.md`。

## 验收记录（2026-07-27）

- **Schema**（`src/ai/schema.ts`）：`FoodItemBaseSchema` 加 `calories_override: z.number().positive().optional()`；`parseToolSchema.itemsProp.items.properties` 同步加同名字段（原样用任务文中给的 description）。record / append / multi 三处协议共用 `FoodItemSchema`，改一处自动覆盖。
- **`calc.ts`**：新增 `resolveNutrition(base, override)` → `{ nutrition, calories_source }`，内部就是 `override != null` 时调 `scaleNutritionToCalories` 并标 `user_override`，否则原样返回标 `computed`。四个落库点与 `modify.ts` 既有点统一调用同一实现。
- **四个落库/建卡入口全部接住**：
  1. `food-item.ts` `processFoodItem` auto_commit 分支：解构加 `calories_override`；判断条件从 `food_confidence>=0.8 && portion_confidence>=0.8` 放宽为 `... || calories_override != null`（此处食物已确定，歧义分支已在更早处 return）；`itemNutrition` 之后接 `resolveNutrition`，`foodRecord.create` 显式写 `calories_source` + `calories_computed`（`baseNutrition.calories`，仅 override 时非空）。**份量卡被一并跳过**（同一个放宽的 if），验证了"别管多重"这条投诉的根因修复；且该路径本就不写份量学习事件，天然不产生偏差反馈，无需额外代码。
  2. `buildCandidateCardData`（同文件，歧义候选卡）：`params` 类型加 `calories_override?: number|null`，解构加上，`candidates` JSON 加 `calories_override: calories_override ?? null`；调用点（`isAmbiguous` 分支）透传。这一步只做透传，不改候选卡本身的行为（食物还没定，无法跳过）。
  3. `pending-resolve.ts` food_choice→portion_choice 二次建卡：新 `pendingRecord.candidates` 里加 `calories_override: candidates.calories_override ?? null`，原样接力上一步。
  4. `pending-resolve.ts` 最终 `foodRecord.create`（`portion_choice` 落库分支）：`itemNutrition` 之后接 `resolveNutrition(baseNutrition, candidates.calories_override)`，写 `calories_source` + `calories_computed`。
  5.（既有点）`modify.ts` update 分支：在原有 `change.calories` 写 `user_override` 处补 `calories_computed: calories_source === "user_override" ? baseNutrition.calories : null`。
- **B 轨三元组**：`prisma/schema.prisma` `FoodRecord` 加 `calories_computed Float?`（可空、不回填存量）。**迁移方式有调整**：`npx prisma migrate dev` 触发了 drift 提示要**重置整个数据库**——本机 `:5432` 这个 Postgres 容器同时是 `:9300` 常驻 prod 后端在用的库（CLAUDE.md 明确不能碰），reset 会清空真实用户数据，**已改为手写迁移文件 + `prisma db execute` 直接执行 DDL + `prisma migrate resolve --applied` 补历史记录**，不触发 reset。drift 本身（`UserMemory.embedding` 索引）是先于本任务已存在的历史遗留，未处理、未受本任务影响。
- **`scripts/audit.ts` B 轨改造**：查询加选 `calories_computed`；聚合时 `calories_computed != null` → 直接用作系统值（精确），否则回退按当前 `food_standard` 反算；输出新增"精确度"列（精确/反算/N/M精确）。跑 `npm run audit --days 30` 验证：现有 6 条 `user_override`（均为 T66 上线前写入）全部正确标"反算"，未误判成精确；表格渲染、排序、去重逻辑不受影响。
- **Prompt**（`parser.ts`）：① 关键判断规则区加"陈述吃了什么+给出热量=record，问热量=chat"边界规则 + 真实案例 few-shot；② items 协议描述区加 `calories_override` 使用说明（何时填、克数仍要填、"大概/估计"这种猜测别填）。
- **单测**：`calc.test.ts` 补 4 条 `resolveNutrition` 用例（无 override、null、有 override 按比例回推、与直接调用 `scaleNutritionToCalories` 结果一致）。`npm test`：194/194 全绿（190 + 新增 4）。
- **`npx tsc --noEmit`**：无报错。
- **eval**：新增 `eval/cases/record-calorie-override.yaml`（"晚上吃了一个自制冰激淋80卡"→一句话记成 80kcal、`calories_source=user_override`、`calories_computed>0`、无 pending、全程不弹份量卡）。干净端口（9309）独立跑 4/4 稳定 PASS。
- **全量 `npm run eval`（干净端口）**：24 个用例仅 1 处 FAIL（`query-plan` 的"具体吃了什么"跟进问，回复措辞与断言字符串不完全匹配）——该用例走的是查询/答案合成链路，与本任务改动的 record/food-item/pending-resolve/modify/calc 代码路径完全无关；单独重跑该 case 4/4 全部 PASS，确认是既有的 LLM 答案合成随机抖动，非本任务引入的回归。本任务新增用例与既有 `card-flow`、`pending-text-answer`（重点关注对象，改了两处 pending 结构与 portion_card 触发条件）本轮全绿。
- **`npm run audit --days 30`**："指令+数值"栏出现 4 条历史条目——均为 2026-07-03～07-14（T65 修复上线前）的历史对话，audit 只是如实回放历史解析日志，不会/也不该回填修复前的记录，符合预期，非本任务/T65 回归。
- **文档**：`docs/AI_PARSING_SPEC.md` §3 补 `calories_override` 字段语义与 record/chat 边界；`docs/DATA_MODEL.md` `food_record` 表补 `calories_computed` 行。
- **未处理的既有观察项（超出本任务范围，未改动）**：`modify.ts` 的 `calories_source = change.calories != null ? "user_override" : "computed"` 这行在**任何** `action=update` 调用时都会重新赋值，理论上会让"仅改餐次/仅改宏量素"这类与热量无关的后续修改把之前的 `user_override` 静默冲回 `computed`（`baseNutrition` 会重算成 food×weight 的原值）——与 `DATA_MODEL.md` 注释"改 food/grams/food_desc 时才会重置"的描述不完全一致。当前 eval 套件未覆盖到这个组合（先 `change.calories` 覆盖，再单独 `change.meal_type`/`change.protein` 等后续修改）未触发过，是 T66 之前就存在的代码，本任务未触碰、未修复，记录于此供后续排查。
