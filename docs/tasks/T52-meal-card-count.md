# T52 — 餐食卡明细显示份数（food_name ×count，替代 raw_input 长文案）

**状态**：✅完成

**目标**：让餐食卡每条明细的主显示从"用户原话子句 `raw_input`"改为"**食物名 + 份数**"（如 `韭菜鸡蛋包子 ×2（180g）`），消除"2 个包子记出一长串废话"的观感。份数由 AI 结构化提取，只用于展示，**绝不参与热量计算**（铁律 1）。

**依赖**：G 轨 T46–T48（meal_card 后端组装 + 组件）。复用 `meal-card.ts` 组装、`food-item.ts` 落库、`ai/schema.ts` FoodItem。
**关注文档**：`AI_PARSING_SPEC.md` §3（count/count_unit 字段）、`DATA_MODEL.md`（food_record.count/count_unit）、`API_SPEC.md`（meal_card items 契约 + 主显示规则）、`DESIGN_SPEC.md` §3.1（明细行渲染）

## 背景（2026-07-05 真机，账号 outoftoken）

用户午餐说"中午吃了两个韭菜鸡蛋包子中等的自己包的没有很多油大概总共加起来两个200克，纯牛奶200毫升"。落库账目干净（韭菜鸡蛋包子 180g/333kcal），但餐食卡明细主显示用的是 `raw_input` 原话子句 = `两个韭菜鸡蛋包子中等的自己包的没有很多油`——2 个包子的标签变成一长串修饰词。

根因：`meal-card.ts:38` 与 API_SPEC 原设计选择 `raw_input` 作主显示以"保留自然单位（两个）"，副作用是把装饰语全拽进标签。现有 AI 返回里 `canonical`（干净名）在，但没有结构化份数——`quantity_expr` 是自由文本（本例 `两个200克`，count 与克数混在一起，正则抠中文数字太脆）。

## 设计要点

### A. AI 输出结构化份数（AI_PARSING_SPEC §3）
- `FoodItem` 加两个可选字段：`count`(number) + `count_unit`(string, 量词「个/碗/片/根」)。
- **仅在原话有明确可数份量时填**：「两个包子」→ `2,"个"`；「一碗面」→ `1,"碗"`。纯重量/容量表达（「50克瘦肉」「200ml 牛奶」）**留空**——克数已由 `portions` 承载，不硬凑量词。
- `quantity_expr` 照旧保留（护栏 `ensureChosenPortion` 仍用），二者不互相替代。
- prompt/schema 两处都要加字段说明（`ai/schema.ts` 的 zod + JSON schema + 系统提示）。

### B. 落库（food_record）
- `food_record` 加两列 `count float?` / `count_unit text?`（可空，迁移）。
- `food-item.ts` 高置信入库路径写入 `count/count_unit`（从 item 透传）；pending→resolve 路径同样带上（candidates 里存，resolve 时落库），保证走份量卡的也能显示份数。
- **旧记录 count 为空**，天然回退到"食物名 + 克数"，不迁移历史。

### C. 卡片组装 + 展示（meal-card.ts / API_SPEC / DESIGN_SPEC §3.1）
- `MealCardView.items` 增加 `count/count_unit` 字段，`buildMealCardView` 从 record 透传。
- 主显示规则：有 `count` → `食物名 ×count`（`weight_g` 作副信息 `（180g）`）；无 `count` → `食物名 weight_g`（旧数据/纯重量）。`raw_input` 不再作主显示（保留在 payload 作留痕，前端不渲染为标签）。

### D. 前端 MealCard 组件
- 明细行按新规则渲染：`food_name` +（有 count 时 `×count`）+ 副信息 `weight_g`；`is_estimated` 角标位置不变。
- 不再显示 `raw_input` 长文案。

## 验收
1. 聊天说"两个包子"（可数）→ 餐食卡明细显示"…包子 ×2（约180g）"，非原话长句。
2. 聊天说"50克瘦肉"（纯重量）→ 明细显示"瘦肉 50g"（无 ×N）。
3. 旧记录（本次迁移前，count 为空）→ 明细回退"食物名 + 克数"，不报错、不显 ×。
4. 热量/宏量素与 count 无关：改不改 count 都不影响 totals（对拍 daily_summary 一致）。
5. `npm run eval` 全绿（铁律：碰 AI 解析必跑），份数字段不破坏既有意图/落库断言。
6. `npm test`（meal-card 组装单测）通过。

## 提示词（可粘贴）
> 见本文件"设计要点 A–D"，按 A(AI schema/prompt)→B(迁移+落库)→C(组装+契约)→D(前端) 顺序做。每步自测。改完 AI 侧务必 `cd backend && npm run eval`。
