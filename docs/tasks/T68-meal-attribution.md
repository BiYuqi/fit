# T68 — 餐次归属重构：item 级 meal_type + 多信号消歧（对话精度 R2）

**状态**：⬜待办

**目标**：修两个同源缺陷：
1. **协议缺陷**：一句话里的不同食物属于不同餐次时，装不下——`meal_type` 是 record 级、全部 items 共用一个。
2. **仲裁缺陷**：一句话里出现多个时段词时，确定性正则"命中即返回"，永远只认最靠前的类别，**哪怕 AI 已经判对了也会被覆盖成错的**。

**依赖**：无。协议层改动，建议排在 T64/T65/T67 之后（同改 `parser.ts`）。
**关注文档**：`AI_PARSING_SPEC.md` §3（record 协议：`meal_type` 位置要变）、§12（multi）、`DATA_MODEL.md`（`food_record.meal_type`）。

## 背景（`npm run audit` 捞出，此前无人投诉）

**缺陷 1 — 一句跨两餐**（2026-07-11）：
```
"昨晚晚餐一个200毫升牛奶，昨天中午的干豆角炖土豆250克"
→ items=2，但 meal_type 只有一个 = dinner
→ 干豆角炖土豆（用户明说中午）被记成了晚餐
```
`RecordVariantSchema` 的 `meal_type` 在 record 级，**结构上就装不下"两样东西属于不同餐次"**。

**缺陷 2 — 正则覆盖了 AI 的正确判断**（2026-07-13）：
```
"早晨的饼 晚上又吃了200克"
AI 判定  : meal_type = dinner     ← 模型判对了！
最终落库 : breakfast              ← 被 extractMealTypeFromText 覆盖成错的
```
用户当场回"你记录错误。是晚上吃的啊"。

`lib/dates.ts` 第 84 行：
```js
if (/早上|早晨|早饭|早餐|上午/.test(text)) return "breakfast";  // "早晨的饼"在这里就 return
if (/中午|午饭|午餐|中饭/.test(text)) return "lunch";
if (/晚上|晚饭|晚餐|傍晚/.test(text)) return "dinner";          // "晚上又吃了"永远轮不到
```
而 `intents/record.ts` 第 44 行明写「**刻意不信 AI 的 `parsed.meal_type`**」，优先级链是 **文本正则 > 续报继承 > 时钟**，AI 的判断根本不参与。

**关键认识**：那条"不信 AI"的注释针对的是**零信号**场景（无时间词时模型爱按上下文脑补餐次）——那个顾虑是对的，不要推翻。但**多个时段词同现是"有信号但需消歧"**，属于语言理解问题，恰恰是 LLM 擅长而正则做不了的。两者不冲突，应当分开处理。

## 设计要点

> **定位方式**：本文件的行号只是写作时的快照，**T64–T68 会依次修改同几个文件，行号必然漂移**。一律用搜索定位（文中给出的段落特征字符串），别照行号跳。


### A. `meal_type` 下沉到 item 级（协议）

> **⚠️ 改 `SYSTEM_PROMPT` 前必读（跨会话协作约定）**
> T64/T65/T67/T68 是**四个独立会话**（每次 `/clear`）先后修改**同一个** `SYSTEM_PROMPT`，彼此看不见对方加了什么。它现在已有 167+ 行，正是"规则堆叠互相稀释"这个病的病灶——别再无脑往后追加。动手前：
> 1. **通读整个 `SYSTEM_PROMPT`**，确认你要加的规则**是否已有相邻条款可以就地改写**，能改写就不新增。
> 2. 新增时**放进语义相关的既有段落**（意图路由规则进意图段、canonical 规则进 canonical 段），不要在文件末尾堆。
> 3. 加完检查**有没有和已有条款矛盾**（尤其别人刚加的）——发现矛盾就一起改掉，别留两条打架的规则。
> 4. few-shot 用真实原话，**同一个案例只保留一份**，别重复举例。

- `FoodItemBaseSchema` 加 `meal_type: MealTypeSchema.optional()`；record 级的 `meal_type` **保留**为该条消息的默认值（绝大多数消息所有食物同餐，不该被迫逐项填）。
- 解析：item 有就用 item 的，没有就继承 record 级。
- `parseToolSchema` 的 `itemsProp` 同步加属性，描述写明：**仅当该食物与本条消息其它食物餐次不同时才填**，否则留空继承外层。
- `SYSTEM_PROMPT` 加规则 + few-shot（用背景里的真实原话）。
- `date_offset` 同理存在这个问题（同例里"昨晚"与"昨天中午"恰好同为 -1 所以没暴露），**本任务一并下沉**，避免下次再来一遍。

### B. 正则改为"承认歧义、交还 AI"（`lib/dates.ts`）
`extractMealTypeFromText` 改成：
1. 扫出**全部**时段词命中（`explicit-signals.ts` 的 `extractExplicitSignals(text).meals` 已经提供了带位置与 `attributive` 标记的命中列表，**直接复用，不要另写一份词表**）。
2. **单一类别命中 → 原样返回**（等价现状，绝大多数消息走这条，行为必须逐字节不变）。
3. **多类别命中 → 返回 `null`（承认歧义）**，把决定权交回调用方。
4. 无命中 → `null`（等价现状）。

`intents/record.ts` 的优先级链相应改为：**文本正则（仅单信号时给出）> AI 的 `parsed.meal_type` > 续报继承 > 时钟**。即"零信号时不信 AI"的原则保持不变，只在**多信号歧义**这一种情形下采信 AI。

搭配 `SYSTEM_PROMPT` 加一条消歧规则：多个时段词同现时，只有**直接修饰进食动作**的才是餐次信号；修饰食物来源的定语（"早晨**的**饼"里的"早晨"修饰名词"饼"）不算。`explicit-signals.ts` 已把 `attributive` 标记算好，可一并注入上下文辅助判断。

### C. 保守要求
`extractMealTypeFromText` 是高频确定性路径，被记录主路径依赖。**单时段词行为必须与改前完全等价**，否则会波及大量既有用例。该函数目前**全仓库零测试覆盖**（`src/lib/` 下没有任何 test 文件）——"先锁现状再改"这一步要自己把测试从零建起来。

## 改动清单
- `backend/src/ai/schema.ts`：`FoodItemBaseSchema` 加 `meal_type` / `date_offset`；`itemsProp` 同步。
- `backend/src/lib/dates.ts`：`extractMealTypeFromText` 改为多信号返回 `null`（复用 `explicit-signals`）。
- `backend/src/lib/dates.test.ts`：**新建**，先锁现状（单时段词各类别 + 无时段词），再加多信号用例。
- `backend/src/services/intents/record.ts`：优先级链插入 AI 兜底；item 级餐次/日期落库。
- `backend/src/services/intents/food-item.ts` / `pending-resolve.ts`：item 级 `meal_type` 透传到 `pending_record.candidates` 与最终落库（**与 T66 的 `calories_override` 是同一批透传点，若 T66 已完成可照抄其做法**）。
- `backend/src/services/parser.ts`：`SYSTEM_PROMPT` item 级餐次规则 + 多信号消歧规则 + few-shot。
- `backend/eval/cases/meal-attribution.yaml`：新增，两条真实原话各一例。
- `docs/AI_PARSING_SPEC.md` §3。

## 验收

**写 eval 用例前先读 `backend/eval/README.md`**——用例格式、断言纪律（禁全文相等）、`{lt}/{gt}/{ne}` 方向性比较器、数值容差 ±0.5、以及"如何减少随机红灯"的写法都在那里。项目惯例：**未修复的缺陷先加用例并标 `known_fail: Txx`，修好后删标记**（红灯清单即已知缺陷清单）。

1. 单测：`extractMealTypeFromText` 单时段词行为与改前**逐条等价**；多时段词返回 `null`。
2. eval：
   - `"昨晚晚餐一个200毫升牛奶，昨天中午的干豆角炖土豆250克"` → 牛奶 dinner、干豆角 lunch，**两条各自归对餐次**，且都落到昨天。
   - `"早晨的饼 晚上又吃了200克"` → 记录落在 **dinner**。
3. 全量 `npm run eval` 无新回归（干净端口）——**重点看含单个时段词的既有记录用例**（`meal-batch`、`chunhuabing` 等）餐次判定完全不变。
4. `npm test` 全绿。

## 提示词（可粘贴）
> 按本文件执行 T68。**动手前先读背景**：`meal_type` 由 `lib/dates.ts` 的确定性正则决定、不由 prompt 决定，且现在会**覆盖掉 AI 的正确判断**；本任务是让正则在多信号时承认歧义、把决定权交回 AI，而"零信号时不信 AI"的原有原则**必须保留**。复用 `src/services/explicit-signals.ts` 的 `meals` 命中列表，不要另写词表。`extractMealTypeFromText` 目前零测试覆盖，先建 `src/lib/dates.test.ts` 锁住单信号现状再改。完成后跑 `npm test` + 干净端口 `npm run eval` + `npm run audit`。遵守 CLAUDE.md 铁律 10/12，完成后把本文件状态改 ✅ 并同步 `docs/TASKS.md`。
