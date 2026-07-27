# T71 — 用户纠正回流食物库：改一次下次就准（估值层 E）

**状态**：⬜已定稿可执行（Q1–Q4 已于 2026-07-27 拍板，见下"决策结论"）

**目标**：用户覆盖热量后，纠正**只作用于那一条记录**，下次记同一食物又回到原来的错值。让系统从覆盖中学到"这个用户吃的这个食物，每 100g 没那么高/没那么低"，下次直接用修正后的密度。

**依赖**：T66（三元组采集）✅ 已完成、T70（权威分级）✅ 已完成。
**关注文档**：`LEARNING_SPEC.md`（学习公式唯一定义处，本任务新增一类学习信号与一个 scope）、`FOOD_DB_SPEC.md` §权威分级、`DATA_MODEL.md`。

## 决策结论（2026-07-27 与用户确认）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 作用域 | **纯个人层**。`food_standard` 永不被用户改；不做"多用户同向后提升为全局"（后续想做再单独立项） |
| Q2 | 能改成分表条目吗 | **不能**。只对 `is_estimated=true` 的估算条目生效 |
| Q3 | 含汤/含水的非线性口径 | **不做**。反推每 100g 密度 + 加权收敛已覆盖，不建"可食固体占比"模型，也不做用户打分 |
| Q4 | 采信强度 | **贝叶斯加权**，但常数重调：估算条目本就只是 AI 随口估的，先验要弱——**一次覆盖移动约 70%**，两次约 88% |

Q1 的决定性理由（任务原文没写）：库里有 `user_override` 的用户 97 个，其中 89 个是 `eval_*` 抛弃号。做成全局的话**每跑一次 `npm run eval` 就往全局食物库灌一轮测试脏数据**（"葱花饼（无油）"已被 eval 覆盖 64 次）。个人层天然隔离，不需要额外写过滤。

Q2 的成本为零：真实用户 6 条覆盖 **100% 命中估算条目**，从没覆盖过成分表条目。

## 关键发现：反推密度会被"重量是谁给的"污染（**最容易做错的地方**）

真实用户（`outoftoken`）6 条覆盖：

| 日期 | 食物 | 库值 | portion_label | 用户说 | 系统算 | 反推每100g |
|---|---|---|---|---|---|---|
| 07-11 | 炒面 | 185 | custom 450g | 850 | 833 | 189 |
| 07-11 | 炸鸡胸肉 | 250 | custom 60g | 185 | 150 | 308 |
| 07-12 | 炖鸡胸肉（冬瓜多肉少） | 35 | custom 200g | 120 | 70 | 60 |
| 07-13 | 冰淇淋（自制） | 200 | **medium 70g（AI 猜的）** | 80 | 140 | 114 |
| 07-14 | 鸡胸肉面条 | 140 | custom 850g | 900 | 1190 | 106 |
| 07-15 | 莲菜肉饺子 | 210 | custom 575g（23个换算） | 1100 | 1208 | 191 |

冰淇淋那条：用户说的"80卡"是**一个的总热量**，不是密度；70g 是 AI 猜的。2026-07-27 用同一句话复现，AI 猜了 80g，反推密度就从 114 变成 100——**同一句话同一用户，学到的密度差 14%，漂移全部来自 AI 的重量猜测**。

所以**只在 `portion_label='custom'`（用户自己报了克数）时才训练**。这与 `LEARNING_SPEC §5` 现有铁规矩（份量偏差"只修 AI 估档，绝不碰 custom"）**互补对称**——同一个字段，两个方向：

- AI 猜的重量 → 训**份量**偏差，不训密度
- 用户报的重量 → 训**密度**偏差，不训份量

一次覆盖只喂一个模型，永不重叠。

次级坑：饺子那条 `custom 575g` 是"23 个 × 25g"AI 换算的，不是用户称的，比真·custom 弱一档 → `count != null` 时 `signal_weight = 0.6`。

## 设计

### 存储：零迁移，全部复用现有表

| 用途 | 复用 | 做法 |
|---|---|---|
| 后验 | `UserBias` | 新增 `scope='food_kcal'`，`scope_key=food_id`（`scope` 本就是自由 String，PK 已含 scope） |
| 审计/回滚 | `BiasUpdateLog` | 原样写，`event_id` 挂到下面的 LearningEvent |
| 事件 | `LearningEvent` | `signal_type='calorie_override'` 的事件 **modify.ts 已经在写**（第 474 行），直接挂载 |

**不新建表、不加列、不写 migration**（T66 的记录里写明本机 `:5432` 与 `:9300` prod 后端共用，`prisma migrate dev` 会触发 reset 危险——本任务从根上避开）。

`LearningEvent` 的 `predicted_grams/applied_grams/final_grams` 三者相等、`log_ratio` 保持 **null**——密度纠正不是克数纠正，不能进 `LEARNING_SPEC §9` 的克数收敛指标，否则把观测指标污染成假性变好。

### 学什么

```
e = ln(用户密度 / 库密度)
用户密度 = record.calories / record.weight_g * 100
库密度   = food_standard.calories_100g      ← 永远用库里的原始值，不是上一轮修正后的值
```

> **必须以库原值为基准**，否则修正会自我复利、指数漂移。`mu` 的语义是"用户真值与库值之间的绝对 log 比"，应用时 `exp(mu*trust)` 乘的也是库原值，天然收敛。

### 训练条件（四条全满足才写）

1. `calories_source === 'user_override'`（用户报了这条的最终热量）
2. `portion_label === 'custom'`（重量是用户给的——见上文陷阱）
3. `food.is_estimated === true`（Q2：成分表条目不动）
4. `weight_g > 0 && 库密度 > 0`

`signal_weight`：`count != null` 时 0.6，否则 1.0。

### 常数（本 scope 专用，与克数偏差各用各的）

| 常数 | 克数偏差现值 | `food_kcal` 取值 | 理由 |
|---|---|---|---|
| PRIOR_SIGMA2 | 0.09 | **0.25** | AI 估的密度轻松差 ±65%，先验就该弱 |
| OBS_SIGMA2 | 0.04 | 0.04 | 用户报的热量比较准，沿用 |
| TRUST_K | 4 | **1.5** | 4 会变成"改四次才有点用"，与"改一次下次就准"直接冲突 |
| N_EFF_CAP | 20 | 20 | 沿用，保留可塑性 |
| CLAMP | ln 3 | ln 3 | 沿用（真实数据最大 e = ln(60/35) = 0.54，远不触发） |
| MULT_RANGE | [0.6, 1.8] | **[0.4, 2.5]** | 冰淇淋需要 0.5、炖鸡胸肉需要 1.71，旧区间盖不住 |

按 `LEARNING_SPEC §5` 的公式代入验算（`updateBias`/`applyBias` 函数体**一行不改**，只换常数）：

- n=1：`mu = 0.862e`、`trust = 0.83` → 实际移动 **0.71e**（≈70%）
- n=2：`mu = 0.926e`、`trust = 0.95` → 实际移动 **0.88e**

真实 6 条数据的 `dev` 全部 < 2，不触发离群降权——说明这组常数没把正常纠正误判成异常。

### 应用点：3 处，其中 2 处走同一个漏斗

`resolveNutrition(base, override)` 已经是"最终写什么营养"的唯一漏斗（T66 建立），加第三个可选参数：

```ts
resolveNutrition(base: ItemNutrition, override?: number | null, kcalMult?: number)
```

`calc.ts` 保持纯函数、可单测；倍率由调用方 `await` 取好再传。

1. `intents/food-item.ts` auto_commit 分支（`const baseNutrition = itemNutrition(food, weight_g);` 那处）
2. `services/pending-resolve.ts` 最终落库分支（同名锚点）
3. `intents/modify.ts`（第 368 行 `itemNutrition(food, weight_g)`）——不改这里的话，用户后续改个餐次就会把修正冲回库原值

**优先级：`calories_override` > 密度修正。** 用户这次亲口报了热量，就用他的，不套任何倍率；这条记录随后成为**训练样本**。

**`routes/records.ts:67` 明确不改**——那是 undo 还原路径，职责是恢复原状，套新倍率是错的。

宏量素与 `scaleNutritionToCalories` 同口径：四个营养字段按同一比例缩放，保持 4/4/9 自洽。

`biasEnabled()`（`LEARNING_BIAS` 环境变量）对本 scope 同样生效，一键可关。

### 可解释性（必做，否则幻觉）

`LEARNING_SPEC §7` 已有先例（"discuss 注入偏差说明，必改否则幻觉"）。本任务同理，但**不主动播报**——每条记录都说一句"已按你的纠正调整"是噪音；只在 `discuss` 被问到"这个数怎么来的"时如实说明。

复用 T70 刚建好的那条 detail 线（`ai/answers.ts` 的 `answerDiscuss` 里"食物库：xx 每100g xxkcal（这个值是 AI 估算的…）"）：该条目对该用户存在 `food_kcal` 修正时，追加"已按你之前的纠正从 200 调整为 100"。倍率在 discuss 时按 `user_id + food_id` 现查 `UserBias`（只读、一次索引查询），**不为此加列**。

## 改动清单

- `backend/src/services/learning.ts`：`food_kcal` 常数组 + `getKcalBias(user_id, food_id)` + `updateKcalBias(...)`（不动现有三层 `getBiases`/`applyBiasToGrams`，避免把克数路径搅乱）
- `backend/src/services/calc.ts`：`resolveNutrition` 加 `kcalMult` 参数
- `backend/src/services/intents/food-item.ts`、`backend/src/services/pending-resolve.ts`：应用倍率 + `calories_override` 落库时补写 `signal_type='calorie_override'` 的 LearningEvent（T66 这两条路径目前不写事件）并触发 `updateKcalBias`
- `backend/src/services/intents/modify.ts`：应用倍率 + 在既有 `change.calories` 的 LearningEvent（第 474 行）后触发 `updateKcalBias`
- `backend/src/ai/answers.ts`：`answerDiscuss` detail 追加修正说明
- `backend/scripts/audit.ts`：B 轨加"已学到的密度修正"表（见下）
- `backend/src/services/learning.test.ts`、`calc.test.ts`：单测
- `backend/eval/cases/calorie-override-learning.yaml`
- `docs/LEARNING_SPEC.md`：§3 信号表把"热量直接指定"从"权重 0 不训练"改成"不训克数、训密度"；§4 加 `food_kcal` 层；§5 加本 scope 常数组；§6 加第 4 条路径
- `docs/DATA_MODEL.md`：`user_bias.scope` 注释补 `food_kcal`

## 可观测（`npm run audit`）

B 轨现有"用户手动覆盖热量的食物"表下方新增一段，每行一个 (用户, 食物)：

```
库值 200 → 已学到 100（×0.50，n_eff=1.7，来自 2 次覆盖）  冰淇淋（自制）
```

**核心指标：覆盖偏差中位数随时间下降**（audit 已按食物聚合并输出中位偏差，直接复用）。上线后新产生的覆盖，其偏差应显著小于历史 6 条——因为系统已经先修正过一轮了。若不降，说明这套没起作用。

同时保留 `BiasUpdateLog` 的逐次回放能力，出问题能查到是哪次覆盖把值带偏的。

## 验收

**写 eval 用例前先读 `backend/eval/README.md`**（断言纪律、`{lt}/{gt}` 比较器、数值容差、减少随机红灯的写法）。

1. **单测**（主战场，密度公式是确定性计算，不该靠 eval 验）：
   - `updateKcalBias`：n=1 移动 ≈0.71e、n=2 ≈0.88e（对着上面的验算数字断言）
   - 训练条件四选一不满足时**不写**（重点：`portion_label='medium'` 不训练、成分表条目不训练）
   - `count != null` → 权重 0.6
   - 护栏：单次极端覆盖（用户说 1kcal）被 CLAMP + MULT_RANGE 挡住，不把条目带到 0
   - **不自我复利**：连续两次覆盖，第二次的 `e` 仍以库原值为基准，倍率收敛而非发散
   - `resolveNutrition` 的 `kcalMult` 与 `override` 同时存在时 override 优先
2. **eval**：`calorie-override-learning.yaml`——先"850克鸡胸肉面条"→改成 900 卡；再记一次同样的 850 克，断言这次热量**直接落在 900 附近**（`{lt}: 1100`），全程无需二次纠正。
3. 全量 `npm run eval` 无新回归（干净端口）——重点看 `record-calorie-override`、`chunhuabing`（都走覆盖路径）。
4. `npm test` 全绿、`npx tsc --noEmit` 无报错。
5. `npm run audit` 新表能正确显示学到的倍率，且历史 6 条覆盖不被误当成已修正。

## 明确不做（防止范围膨胀）

- ❌ 改 `food_standard`（全局层）——Q1 已定，想做另行立项
- ❌ 类目层密度偏差——真实数据里方向互相打架（炸/炖鸡胸肉是系统**低**估，鸡胸肉面条是系统**高**估），做了会互相抵消学出 0，白加复杂度
- ❌ 含水率/可食固体占比建模、用户打分（Q3）
- ❌ 用户覆盖后主动播报（只在 discuss 被问时说）
- ❌ 回填历史记录的热量——学习只影响**之后**的记录，与 T33 复核"不回改历史 food_record"一致

## 一条必须记下的诚实判断

任务原稿称"同一个错无限重复，正是 outoftoken 反复改的原因"——**这个论据在真实数据里站不住**：他那 6 条覆盖是 6 个**不同**食物，没有任何食物被跨会话改过两次。真正的"反复改"发生在单次对话内（"我都说80了""你别管多重行吗"），而**那个痛点 T66 已经修掉了**。

所以 T71 的收益是**前瞻性的，不是止血**。支持它的证据是：177 条记录里 104 条（59%）落在吃过 ≥2 次的食物上，重复暴露真实存在，只是覆盖行为还没撞上重复食物。

**因此本任务按最小可用范围做**（零迁移、3 个应用点、只学 food 层），不预先建设更复杂的机制；等 audit 的偏差中位数曲线证明有效、且真实出现"同一食物反复覆盖"再考虑扩。

## 提示词（可粘贴）

> 按本文件执行 T71。**先读"关键发现"那节**——`portion_label='custom'` 才训练是整个任务最容易做错的地方，做错了模型会学到 AI 的重量猜测噪声。实现顺序：`learning.ts` 加常数与 `getKcalBias`/`updateKcalBias`（复用现有 `updateBias`/`applyBias` 函数体，只换常数）→ 单测跑通验算数字 → `calc.ts` 加 `kcalMult` → 3 个应用点 → discuss 可解释 → audit 可观测 → eval。**两个致命点**：(a) `e` 永远以 `food_standard` 库原值为基准，不能拿上一轮修正后的值当基准，否则指数漂移；(b) `calories_override` 优先于密度修正，且该记录随后要成为训练样本。**不新建表、不写 migration**——`UserBias.scope` 是自由 String，加 `food_kcal` 即可；本机数据库与 `:9300` prod 共用，`prisma migrate dev` 会触发 reset 危险。遵守 CLAUDE.md 铁律 10/12，完成后把本文件状态改 ✅ 并同步 `docs/TASKS.md`。
