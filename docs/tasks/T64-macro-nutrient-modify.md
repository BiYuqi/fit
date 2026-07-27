# T64 — 宏量素修改：协议缺失导致静默改错数据（对话精度 R2）

**状态**：✅已完成　　**优先级：本轨最高**（唯一一条会静默写错数据的缺陷）

**目标**：用户说"把蛋白质改成8克"时，系统当前会**把重量改成 200 克**——协议里根本没有 protein/fat/carbs 字段，模型只能把指令塞进它有的字段。用户以为改了蛋白质，实际是重量被悄悄改了，回执也不会暴露。给 `modify.update` 补上宏量素修改能力。

**依赖**：无。
**关注文档**：`AI_PARSING_SPEC.md` §8（modify 协议，需新增字段定义）、`DATA_MODEL.md`（`food_record` 营养字段语义）、`CALORIE_ENGINE.md`（改宏量素后热量是否跟着变，见下"必须先定的口径"）。

## 背景（2026-07-03 真机，账号 outoftoken，`npm run audit` 首次扫描发现）

```
用户: "不对。我说的是刚才喝的牛奶被你记录成6克蛋白质。改成8克"
系统: {"intent":"discuss","target":"r1"}                      ← 只解释，没动数据

用户: "把蛋白质改成8克"
系统: {"action":"update","change":{"grams":200,"portion_label":"custom"},...}
                                    ↑↑↑ 把重量改成了 200 克！
```

`ModifyChangeSchema`（`src/ai/schema.ts`）现有字段只有：`portion_label / grams / food / meal_type / calories_burned / calories / food_desc / date_offset`——**没有任何宏量素字段**。模型接到"改成8克"这个指令，只能找一个带"克"的字段填进去，于是填了 `grams`。

用户当时说了两句就放弃了，所以这条从没进过任务列表，**已静默存在 3 周**。这也是 T63 审计工具立项后立刻捞出来的两个"无人投诉"缺陷之一。

## 必须先定的口径（实现前确认，别自己拍）

改了蛋白质，**热量要不要跟着变**？三种口径，本任务采用第 3 种：

1. 热量不动 → 数据自相矛盾（蛋白 8g 但热量还是按旧值算的）
2. 按 4/9/4 kcal/g 重算整条热量 → 会覆盖掉可能更准的实测热量，且与 `calories_source=user_override` 冲突
3. **只改用户指定的那个宏量素，热量不动，并在回执里说明**——用户纠正的是单一营养字段，没有授权系统重算别的。与 T40 `change.calories` 的处理精神一致（用户报什么就改什么，不外扩）

同时 `calories_source` **保持不变**（用户改的是蛋白质不是热量，不该把热量标记成用户覆盖）。

## 设计要点

> **定位方式**：本文件出现的行号只是写作时的快照，**T64–T68 会依次修改同几个文件，行号必然漂移**。一律用搜索定位（文中给出的段落特征字符串），别照行号跳。

### A. Schema（`src/ai/schema.ts`）
`ModifyChangeSchema` 新增三个可选字段（注意该 schema 外层有 `z.preprocess` 剥 null，新字段自动享受该保护）：
```ts
protein: z.number().min(0).optional(),   // 用户直接指定的蛋白质克数（用户真值）
fat: z.number().min(0).optional(),
carbs: z.number().min(0).optional(),
```
`parseToolSchema` 的 `changeProp.properties` 同步加三个 `{type:"number"}`，描述参照现有 `calories` 那条的写法（强调"用户真值，不是 AI 估算"）。

### B. Prompt（`src/services/parser.ts` `SYSTEM_PROMPT`）

> **⚠️ 改 `SYSTEM_PROMPT` 前必读（跨会话协作约定）**
> T64/T65/T67/T68 是**四个独立会话**（每次 `/clear`）先后修改**同一个** `SYSTEM_PROMPT`，彼此看不见对方加了什么。它现在已有 167+ 行，正是"规则堆叠互相稀释"这个病的病灶——别再无脑往后追加。动手前：
> 1. **通读整个 `SYSTEM_PROMPT`**，确认你要加的规则**是否已有相邻条款可以就地改写**，能改写就不新增。
> 2. 新增时**放进语义相关的既有段落**（意图路由规则进意图段、canonical 规则进 canonical 段），不要在文件末尾堆。
> 3. 加完检查**有没有和已有条款矛盾**（尤其别人刚加的）——发现矛盾就一起改掉，别留两条打架的规则。
> 4. few-shot 用真实原话，**同一个案例只保留一份**，别重复举例。

modify 段补一条：用户直接给出某条记录的**宏量素**数值（"蛋白质改成8克"、"脂肪应该是5克"、"碳水按30算"）→ `change.protein/fat/carbs`，**不要填 `grams`**（那是食物重量，不是营养含量，混淆会改错数据）。配 few-shot，用背景里的真实原话。

**与 T65 的分工**（本任务在前，别越界）：背景里第一条"…被记录成6克蛋白质。改成8克"被判成 `discuss`，那是"指令夹在长文本里被吞"的病，归 **T65**；本任务只管"判成了 modify 之后，change 里有没有地方放宏量素"。所以本任务的 eval 用例请用**干净的指令句**（"把蛋白质改成8克"），别用那条长的——那条要等 T65 做完才会绿。

### C. 落库（`src/services/intents/modify.ts`）
`applyUpdate` 一带（约第 340-385 行，`baseNutrition` / `nutrition` 那段）：
- 现在是 `const nutrition = change.calories != null ? scaleNutritionToCalories(...) : baseNutrition;`
- 改成：在此基础上，若 `change.protein/fat/carbs` 有值，**逐字段覆盖** `nutrition.protein_g/fat_g/carbs_g`，热量不动。
- `prisma.foodRecord.update` 的 `data` 已经在写 `protein/fat/carbs`，覆盖后自然落库。
- **注意 `calories_source` 不要因此变成 `user_override`**（现有代码是 `change.calories != null ? "user_override" : "computed"`，保持这个判断不变即可，别顺手把宏量素也算进去）。

### D. 撤销与回执
- `prev_state`（`meal_card.payload.last_changes`，约第 314 行）已经带了 `protein/fat/carbs`，撤销天然能还原，**确认即可，无需改**。
- 回执文案要明确说改的是哪个宏量素（"已修改：纯牛奶 蛋白质 6g → 8g"），不能像改重量那样含糊——用户就是因为看不出改了什么才吃过亏。

## 改动清单
- `backend/src/ai/schema.ts`：`ModifyChangeSchema` 加 3 字段；`changeProp.properties` 加 3 属性。
- `backend/src/services/parser.ts`：`SYSTEM_PROMPT` modify 段加规则 + few-shot。
- `backend/src/services/intents/modify.ts`：`applyUpdate` 覆盖宏量素；回执文案。
- `backend/eval/cases/macro-modify.yaml`：新增。**写之前先读 `backend/eval/README.md`**（用例格式、断言纪律、`{lt}/{gt}/{ne}` 比较器、数值容差 ±0.5、如何减少随机红灯，都在那）。
- `docs/AI_PARSING_SPEC.md` §8：补 `change.protein/fat/carbs` 字段说明与口径（热量不动、`calories_source` 不变）。

## 验收

**写 eval 用例前先读 `backend/eval/README.md`**——用例格式、断言纪律（禁全文相等）、`{lt}/{gt}/{ne}` 方向性比较器、数值容差 ±0.5、以及"如何减少随机红灯"的写法都在那里。项目惯例：**未修复的缺陷先加用例并标 `known_fail: Txx`，修好后删标记**（红灯清单即已知缺陷清单）。

1. eval 新用例：先记一条牛奶，再说"把蛋白质改成8克" → `food_record.protein` 变 8，**`weight_g` 与 `calories` 均不变**，`calories_source` 仍为 `computed`。
2. 撤销能还原蛋白质原值。
3. `npm test` 全绿；全量 `npm run eval` 无新回归（干净端口，别打 `:9300`）。
4. **`npm run audit` 的"宏量素修改（协议缺失）"一栏可疑数应下降**（历史数据不会变，但新发生的同类消息不应再进这一栏——可用 `--days` 验证）。

## 提示词（可粘贴）
> 按本文件执行 T64。这是当前唯一会**静默写错数据**的缺陷（用户说改蛋白质，系统改了重量），优先做。**动手前先读"必须先定的口径"一节**：改宏量素时热量不动、`calories_source` 保持 `computed`，别自作主张按 4/9/4 重算热量。改完跑 `npm test` + 干净端口 `npm run eval`，并用 `npm run audit` 确认该类不再新增。遵守 CLAUDE.md 铁律 10/12，完成后把本文件状态改 ✅ 并同步 `docs/TASKS.md`。

## 验收记录（2026-07-27）

- **Schema**：`ModifyChangeSchema` 加 `protein/fat/carbs`（`z.number().min(0).optional()`），`changeProp.properties` 同步三个字段。
- **Prompt**：modify 段在 `change.calories` 条后加一条宏量素规则 + 明确"绝不填 grams"的对比说明，未新增段落、放进既有语义相邻处。
- **落库**（`modify.ts` `applyUpdate`）：`baseNutrition` 之后按 `change.protein/fat/carbs` 逐字段覆盖，热量与 `calories_source` 判断不受影响。
  - **实现中发现并修复一个真实 bug**：最初版本每次都从 `itemNutrition(food, weight_g)` 重新算基准，若本轮只改了一个宏量素（如碳水），会把上一轮已经改过的宏量素（如蛋白质）冲回食物库原值——"只改点名字段"没有做到。修复：食物/克数本轮未变时，未点名的宏量素字段回退到**当前记录值**（`rec.protein/fat/carbs`）而非重新按 food×grams 计算，让连续多次分别纠正互不冲掉。已同步补进 `AI_PARSING_SPEC.md` §8。
  - 回执文案按设计要点 D 写清"蛋白质 6g → 8g"这类具体变化。
- **eval**：新增 `eval/cases/macro-modify.yaml`（3 轮：记牛奶 → 改蛋白质8g → 改碳水10g，验证互不冲突），干净端口全跑 3/3 PASS。
- **全量 `npm run eval`**：22 用例，4 处首次红灯（meal-batch/quantifier-delete×2/query-plan），单独重跑全部转绿——确认是已知的 LLM 输出抖动（详见 memory「eval抖动实锤」），非本任务引入的回归；`macro-modify` 首次即全绿。
- **`npm test`**：190/190 全绿。
- **`npm run audit`**："宏量素修改（协议缺失）"一栏仍显示 2026-07-03 的 2 条历史数据（预期内，audit 不改历史），修复后无新增同类样本。
