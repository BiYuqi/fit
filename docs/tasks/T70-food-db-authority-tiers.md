# T70 — 食物库权威分级 + 脏条目清理（估值层 E）

**状态**：✅已完成

**目标**：AI 估算出的条目一旦落库，就与真实食物成分表**享有完全同等的权威**，且此后不再复核。修正这个不对等，并清掉已产生的脏条目。这是 B 轨里**范围确定、无需产品决策**的部分（需决策的回流机制在 T71）。

**依赖**：无。不碰对话解析链路，与 A 轨可并行。
**关注文档**：`FOOD_DB_SPEC.md`（三层结构与数据源，需补权威分级）、`AI_PARSING_SPEC.md` §5（匹配管线）、`CLAUDE.md` 铁律 1（本任务不改铁律，但澄清它的适用前提）。

## 背景（`npm run audit` 全量扫描，2026-07-27）

```
条目来源分布：
  成分表 / composition_table：1632 条
  AI估算  / ai：119 条 ＋ ai_reviewed：7 条

真实记录命中的条目类型：
  成分表：35 条（16.4%）
  AI估算：178 条（83.6%）   ← 用户实际吃到的，八成命中的是 AI 估的值
```

**这不是 bug，是结构性错配**：`composition_table` 是**食物成分表**（原料级：大米、面粉、猪里脊），而用户嘴里说的是**成品菜**（卤牛肉、葱花饼、莲菜肉饺子、煎鸡胸肉汤面条）。中式家常菜的组合是无穷的，**靠扩库永远追不上**——所以 83.6% 走估算是必然，不该也无法消灭。

真正的问题是：**估出来的值获得了本不该有的权威**。
- `matchFood`（`services/matcher.ts`）的**精确匹配与 alias 匹配都不过滤 `is_estimated`**，trgm 分支也没过滤（只有前缀分支过滤了）。所以第一次估出的"葱花饼 267kcal/100g"成为此后所有"葱花饼"的事实源。
- 119 条估算里只有 **7 条**被 T33 复核过。
- `FoodStandard` **没有 user_id，是全局表**——一个用户的一次估算，污染的是所有用户的库。

于是形成 T69 背景里那个尴尬局面：系统拿「三周前 AI 随口估的 140kcal/100g」去否决用户此刻的判断，理由是"食物库说的"。

**顺带发现的脏条目**（属性修正变体命名叠加所致）：
```
葱花饼（无油）（无油）              230 kcal/100g
炖鸡胸肉（冬瓜多肉少）（冬瓜多肉少）   35 kcal/100g
```

## 设计要点

### A. 修复变体命名叠加（`services/intents/modify.ts` 约 341 行）
```ts
food = await matchFoodExactOrEstimate(`${food.name}（${change.food_desc}）`, text, user_id);
```
`food.name` 若**已经**带了同样的后缀，会再拼一次。改法：拼接前检查 `food.name` 是否已包含 `（${change.food_desc}）`，已含则复用原名不再叠加。

顺带清理存量两条脏数据（写进 migration 或一次性脚本均可，但要**先确认没有 `food_record` 指向它们**；有的话应指回正确条目再删，别留悬空外键）。

### B. `is_estimated` 权威分级（`services/matcher.ts`）
原则：**估算条目可以被命中复用（否则每次都要重估、又慢又贵），但不该压过更强的证据。**

最小可行改动：
1. `matchFood` 的 trgm 分支补 `is_estimated = false` 过滤，与 `matchFoodCandidates` 对齐（现在两处不一致，本身就是隐患）。
2. 精确/alias 命中一个 `is_estimated=true` 的条目时，**保留命中**（不改行为），但把这一事实透传给上层——供 T71 的回流机制与 `discuss` 回复使用（AI 解释"这个数是怎么来的"时，应能如实说"这是估算值"而不是"食物库说的"）。`ItemResult`/trace 里已有 `match_path`，可扩展为区分 `ai_estimate_reuse`。

**不要**做的：不要禁止复用估算条目（会导致重复估算、成本与不一致激增）；不要在本任务里改估值本身（那是 T71，需要决策）。

### C. 澄清铁律 1 的适用前提（`CLAUDE.md` / `FOOD_DB_SPEC.md`）
铁律 1「AI 绝不算账，热量只能由后端用 `food_standard` 的每100g数值 × 克数算出」**本身不改**，但它隐含"食物库是可靠事实源"这个前提，而 83.6% 的情况下那个"事实"本身就是 AI 估的。

在 `FOOD_DB_SPEC.md` 里写明这个分层现实：成分表条目 = 权威事实；`is_estimated` 条目 = 系统的**当前最佳估计**，可被更强证据（用户实测、复核）修正。**这不是削弱铁律 1**——AI 依然不许在回话时心算热量；改变的只是"库里的值有多硬"这一认知，以及由此推出的：用户报的真值不该被一个估算值压过去。

## 改动清单
- `backend/src/services/intents/modify.ts`：变体命名去重。
- `backend/src/services/matcher.ts`：trgm 分支补 `is_estimated` 过滤；命中估算条目的事实透传。
- `backend/prisma/migrations/` 或 `scripts/`：清理 2 条叠加脏条目（先查外键引用）。
- `docs/FOOD_DB_SPEC.md`：新增"权威分级"一节；`docs/CLAUDE.md` 铁律 1 旁加一句适用前提的指引（**不改铁律本身**）。
- `backend/eval/cases/`：属性修正连改两次不产生叠加后缀的用例。

## 验收
1. 对同一条记录连续两次 `change.food_desc="无油"` → 食物名仍是 `葱花饼（无油）`，**不出现二次叠加**。
2. 存量 2 条脏条目已清理，且无 `food_record` 悬空引用（清理前后各查一次）。
3. `npm run audit` 的"属性后缀重复叠加"告警清空。
4. 全量 `npm run eval` 无新回归（干净端口）——重点看 trgm 过滤变化会不会让某些既有匹配用例改走估算路径。
5. `npm test` 全绿。

## 提示词（可粘贴）
> 按本文件执行 T70。这是 B 轨里**不需要产品决策**的部分，别顺手把"用户覆盖回流食物库"一起做了（那是 T71，口径待定）。三件事：修变体命名叠加、trgm 分支补 `is_estimated` 过滤、清 2 条存量脏条目（**清理前先查有没有 `food_record` 指向它们**）。文档侧把"估算条目 ≠ 成分表条目"这个分层写进 `FOOD_DB_SPEC.md`，铁律 1 本身不要改。完成后跑 `npm test` + 干净端口 `npm run eval` + `npm run audit`。遵守 CLAUDE.md 铁律 10/12，完成后把本文件状态改 ✅ 并同步 `docs/TASKS.md`。

## 验收记录（2026-07-27）

### 改动
- `backend/src/services/intents/modify.ts`（约341行）：`change.food_desc` 拼接变体名前先判断 `food.name` 是否已带同样后缀（`endsWith(suffix)`），已带则复用原名，不再叠加。
- `backend/src/services/matcher.ts`：`matchFood` 的 trgm 分支补 `is_estimated = false` 过滤，与 `matchFoodCandidates` 对齐。另加 `tagEstimateReuse` helper——精确/alias 命中一条 `is_estimated=true` 的条目时打一个不落库的 `_estimateReused` 标记（不改返回值本身，不改复用行为）。
- `backend/src/services/intents/food-item.ts`：`inferMatchPath` 新增 `_estimateReused` 判断，命中"复用旧估算"时 `match_path` 记 `ai_estimate_reuse`，与"本次现估"（`ai_estimate`）区分开，写入 trace。
- `backend/src/ai/answers.ts`：`answerDiscuss` 的 `fullRecord.food` 类型补 `is_estimated: boolean`（`routes/chat.ts` 的 `include: { food: true }` 本就带这个字段，只是类型和 detail 拼接没用上）；`detail` 拼"食物库：…每100g…kcal"那行按 `is_estimated` 分叉，估算值额外提示"这个值是 AI 估算的，不是成分表标准值——如实说是估算，不要说'食物库标准值'"，成分表值标"（成分表标准值）"。这是"命中估算条目的事实透传给 discuss"这一条的落地——不加这行的话，T69 里 PERSONA_BASE 那句"is_estimated 食物可以如实说这是估算值"其实没有数据支撑，模型无从判断。
- `backend/scripts/t70-cleanup-dirty-food-variants.ts`：一次性清理脚本，幂等（无脏条目时直接退出，可安全重跑）。处理顺序：查脏条目 → 找对应正确单后缀条目 → 把 `food_record`/`learning_event`/`user_food_alias`（非脏名 key 的）的 `food_id` 改指向正确条目，脏名本身的 alias key（不会再被任何代码路径查到）直接删 → 删脏 `food_standard` 行。**未写成 prisma migration**：这是历史脏数据的一次性修复，不是 schema 变更，写成 migration 反而会让"迁移历史"里混进一次性数据订正，选了 scripts/。
- `backend/eval/cases/food-desc-no-double-suffix.yaml`：新增回归用例，record 一条 → `改成无油版` → 再次强调同一属性 `还是无油版，你还没改对`，断言两次修正后 `food_name` 都精确等于 `葱花饼（无油）`（用 `food_name` 字段做精确比较，不是 `where.food_name` 的 contains 模糊匹配）。
- `docs/FOOD_DB_SPEC.md`：新增"### 权威分级（T70）"一节（三层结构小节内）。
- `CLAUDE.md`：铁律 1 后加括号说明适用前提（`is_estimated=true` 条目本身是 AI 估的，权威性不等于成分表条目；铁律本身文字未改）。

### 存量脏条目清理
清理前查引用：`葱花饼（无油）（无油）`（12 条 `food_record`、11 条 `user_food_alias`、26 条 `learning_event`）、`炖鸡胸肉（冬瓜多肉少）（冬瓜多肉少）`（1 条 `food_record`、2 条 `user_food_alias`、4 条 `learning_event`）——两者对应的正确单后缀条目（`葱花饼（无油）`、`炖鸡胸肉（冬瓜多肉少）`）均已存在于库中，不需要现估新建。跑脚本后：`food_record`/`learning_event`/`user_food_alias` 全部改指向正确条目（`user_food_alias` 里 1 条 key 本身就是脏后缀名的额外删除），脏 `food_standard` 行删除成功，无外键报错。重跑脚本确认幂等（"没有找到叠加后缀的脏条目，无需清理。"）。

### 验收对照
1. ✅ 同一属性连改两次不叠加：见上面 `food-desc-no-double-suffix.yaml`，跑了 3 次（全量套件里 1 次 + 单独 2 次）全部 `葱花饼（无油）` 精确匹配，未出现二次叠加。
2. ✅ 存量 2 条脏条目已清理，清理前后各查一次确认无悬空引用（见上）。
3. ✅ `npm run audit` 重跑，"食物库健康度"一节不再出现"属性后缀重复叠加"告警（该告警块整段消失，因为触发条件 `dupSuffix.length` 现在是 0）。
4. 🟡 全量 `npm run eval`（干净端口 `:9309`）：新回归 3——`chunhuabing` 2 条（第3轮"油/无油"追问被判成 modify 非 chat/discuss；第7轮"晚饭再加80克鸡蛋葱花煎饼"被判成 chat 非 record/modify）、`meal-batch` 1 条（"今天晚饭吃了什么"meal_type 判错）。单独用 `--case chunhuabing` 重跑 2 次，2/2 全绿——两条失败都是 `parser.ts` 意图分类的 LLM 概率性波动，且 T70 完全没碰 `parser.ts`；`meal-batch` 这个具体失败模式（"以上发的都是早餐"后查"晚饭吃了什么"meal_type 判错）与已有 memory 记录（"eval抖动实锤:meal-batch基线也误红"）完全吻合的既有基线抖动，不重复占用 API 额度重跑。trgm 过滤加了 `is_estimated=false` 后，也没有观察到任何既有用例的匹配结果从"命中真实条目"改判成了"估算路径"（若有会在 calories/protein 断言上直接炸，全量套件里没有这类失败）。
5. ✅ `npm test` 207/207。

### 未做/明确排除
- T71（用户覆盖回流食物库的具体算法/触发阈值）按任务边界未做，需产品决策。
- `_adjudicated` 标记（`food-item.ts` 的 `inferMatchPath` 里 `ai_adjudicate` 分支）在读代码时发现从未被任何地方实际赋值（死分支，`adjudicated_by_ai` trace 字段恒为 `false`）——这是本任务之外的既有缺陷，不在本任务改动清单内，未处理，留给之后单独的任务处理。
