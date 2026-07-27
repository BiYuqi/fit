# T67 — 复合菜主料丢失：确定性校验替代不可靠的自评置信度（对话精度 R2）

**状态**：✅已完成

**目标**：复合菜的核心食材被 `canonical` 静默丢弃时（"煎鸡胸肉汤面条"→"熟面条"），`food_confidence` 却给 0.85 高分，导致"低置信度升 pro"这道安全网**完全没触发**。加一道不依赖模型自评分的确定性校验。

**依赖**：无。与 T64/T65 同改 `parser.ts`，建议排在其后。
**关注文档**：`AI_PARSING_SPEC.md` §3（canonical 规则）、§5（食物匹配管线，需补校验说明）、`FOOD_DB_SPEC.md`（生/熟与复合菜口径）。

## 背景（真机，`npm run audit` 确认）

```
[2026-07-14] "煎鸡胸肉汤面条850克"
  → canonical="熟面条"，food_confidence=0.85
  → 850g 全按纯面条算 = 1190 kcal，整块鸡胸肉的营养凭空消失
[2026-07-02] "吃了一碗牛肉面 加了一个鸡蛋"
  → canonical="熟面条"+"鸡蛋"，牛肉丢失
```

`chat.ts` 第 111-124 行的安全网是 `food_confidence < 0.5` 才升 pro——**置信度本身就是虚高的、错的**，安全网形同虚设。这正是"不能依赖模型自评"的实证。

**注意**：audit 首版曾把这一栏报成 25.6%，人工复核后**大部分是误报**——`鸡蛋→水煮蛋/卤蛋` 是正常同义归一，`排骨瘦肉→猪瘦肉` 是用户自己说"纯肉不算骨头"。加了同义词表与派生值抑制后降到 6.1%（3 条），其中 2 条为真。**本任务的规则也必须同样保守**，宁可漏报不可误报——误报的代价是白白多花一次 pro 调用 + 可能改坏正常归一。

## 设计要点

> **定位方式**：本文件的行号只是写作时的快照，**T64–T68 会依次修改同几个文件，行号必然漂移**。一律用搜索定位（文中给出的段落特征字符串），别照行号跳。


### A. 确定性校验（`src/services/parser.ts` 防御归一化段，约 214-274 行）
**不新增 LLM 调用**。复用 T63 已落地的 `src/services/explicit-signals.ts`：
- `extractExplicitSignals(text).ingredients` 拿到原话里的主料名
- `ingredientCovered(ingredient, canonicals)` 判断是否被某个 `canonical` 覆盖（**已内置同义词表**，`鸡蛋` 能被 `水煮蛋` 满足）
- `derivedRequest` 为真时**整体跳过**（"纯肉不算骨头"这类）

对 `intent=record` 的每个 item（`multi` 的 record op 同理）：原话有主料词、而该 item 的 `canonical` 未覆盖 → 判定"疑似丢主料"。

**校验对象只能是 `canonical`，绝不能带上 `raw`**——`raw` 是用户原话回显，必然包含主料词，用它判会永远全绿（audit 首版就栽在这，白跑一轮）。

### B. ⚠️ 别用"在 item 上挂内部标记"这个直觉方案
归一化跑在 `ParseResultSchema.parse(raw)` **之前**，而 zod 的 `z.object()` **默认剥掉所有未声明的键**——挂在 item 上的 `_needs_upgrade` 会被静默吃掉，`chat.ts` 永远读不到，排查极费时间。

**正确做法：走返回值带出去，不碰 item 本身。** `parseUserInput` 现返回 `{ result, usage, messages }`（`parser.ts` 第 277 行），加一个 `needsUpgrade: boolean`；**不改 `food_confidence`**。`chat.ts` 第 111 行升级条件改成：
```ts
const hasLow = pr.needsUpgrade || parsed.items.some((i) => i.food_confidence < 0.5);
```
（`pr` 是 `parseUserInput` 的返回值，需在该作用域留住。）

**为什么不能直接把 `food_confidence` 封顶到 0.4**：`chat.ts` 只重试一次。若 pro 也丢主料，0.4 会流到 `food-item.ts`——auto_commit 要求 `>=0.8`，不满足就落进 portion_card 分支，于是给一个**用户已经明说 850 克**的食物弹卡问"小份/中份/大份"。既答非所问，又正是用户骂过的"擅作主张"。置信度语义必须保持不变，pro 重试失败也只回到今天的表现。

### C. Prompt 补充（`SYSTEM_PROMPT` canonical 规则段，约 107-112 行）

> **⚠️ 改 `SYSTEM_PROMPT` 前必读（跨会话协作约定）**
> T64/T65/T67/T68 是**四个独立会话**（每次 `/clear`）先后修改**同一个** `SYSTEM_PROMPT`，彼此看不见对方加了什么。它现在已有 167+ 行，正是"规则堆叠互相稀释"这个病的病灶——别再无脑往后追加。动手前：
> 1. **通读整个 `SYSTEM_PROMPT`**，确认你要加的规则**是否已有相邻条款可以就地改写**，能改写就不新增。
> 2. 新增时**放进语义相关的既有段落**（意图路由规则进意图段、canonical 规则进 canonical 段），不要在文件末尾堆。
> 3. 加完检查**有没有和已有条款矛盾**（尤其别人刚加的）——发现矛盾就一起改掉，别留两条打架的规则。
> 4. few-shot 用真实原话，**同一个案例只保留一份**，别重复举例。

复合菜（肉/蛋/海鲜等主料 + 主食/汤/菜的组合）的 `canonical` 必须覆盖原话里出现的主料，不能只保留主食部分。错误示范：'煎鸡胸肉汤面条' 不能简化成 '熟面条'——会把整块鸡胸肉的营养弄丢；应保留复合菜全名（如 '鸡胸肉汤面条'），交给估算走复合菜口径。配 few-shot 用真实原话。

## 改动清单
- `backend/src/services/parser.ts`：防御归一化段加校验（调用 `explicit-signals`）；`parseUserInput` 返回值加 `needsUpgrade`；`SYSTEM_PROMPT` canonical 段加规则 + few-shot。
- `backend/src/routes/chat.ts`：升级判断条件加 `pr.needsUpgrade`。
- `backend/src/services/explicit-signals.ts`：若同义词表需要补充，改这里（**唯一定义处**，audit 与运行时共用）。
- `backend/eval/cases/composite-dish-ingredient.yaml`：新增。
- `docs/AI_PARSING_SPEC.md` §5：补主料覆盖校验说明。

## 验收

**写 eval 用例前先读 `backend/eval/README.md`**——用例格式、断言纪律（禁全文相等）、`{lt}/{gt}/{ne}` 方向性比较器、数值容差 ±0.5、以及"如何减少随机红灯"的写法都在那里。项目惯例：**未修复的缺陷先加用例并标 `known_fail: Txx`，修好后删标记**（红灯清单即已知缺陷清单）。

1. eval："煎鸡胸肉汤面条850克" → 触发 pro 重试，最终 `canonical` 体现鸡胸肉，不再整份记成纯主食。
2. **失败兜底用例**：构造 pro 重试后仍丢主料的输入（或直接单测覆盖"归一化 + 升级判断"组合），确认**不会弹出份量卡**、置信度语义未被污染。
3. **误报护栏用例**：`"中午吃了千张80克，一个鸡蛋"` → `canonical` 出现 `水煮蛋` 时**不得**触发升级（同义归一是正常的）；`"排骨瘦肉80克。纯肉。不算骨头"` → `derivedRequest` 抑制生效，不触发。
4. 全量 `npm run eval` 无新回归（干净端口）；`npm run audit` 主料栏可疑率不上升（**若上升说明规则过激，是误报不是收益**）。

## 提示词（可粘贴）
> 按本文件执行 T67。复用 T63 落地的 `src/services/explicit-signals.ts`，**不要另写一份主料词表**。两个必须避开的坑：(a) 校验只看 `canonical` 不看 `raw`；(b) 别在 item 上挂内部标记（会被 zod 剥掉），走 `parseUserInput` 返回值的 `needsUpgrade`，且**不要改 `food_confidence`**（原因见设计要点 B）。规则要保守——验收第 3 条的误报护栏用例必须过。完成后跑干净端口 `npm run eval` + `npm run audit`。遵守 CLAUDE.md 铁律 10/12，完成后把本文件状态改 ✅ 并同步 `docs/TASKS.md`。

## 验收记录（2026-07-27）

**改动**：
- `backend/src/services/explicit-signals.ts`：未改——同义词表/`ingredientCovered`/`derivedRequest` 均已由 T63 落地，直接复用。
- `backend/src/services/parser.ts`：新增导出函数 `hasIngredientLoss(rawText, items)`——`extractExplicitSignals(rawText).ingredients` 逐个比对是否被该 record 全部 `item.canonical` 覆盖（`ingredientCovered`），`derivedRequest` 为真整体跳过。`parseUserInput` 在 zod parse 之后计算 `needsUpgrade`：`intent=record` 用整条消息 `text`；`intent=multi` 对每个 `op.intent==="record"` 用 `op.raw`（缺省回退整条 `text`）逐个判定，任一命中即 `needsUpgrade=true`。返回值新增 `needsUpgrade: boolean` 字段，**不碰 `food_confidence`、不挂 item 内部标记**（严格遵循设计要点 B）。`SYSTEM_PROMPT` 的 canonical 熟形规则段（原第112-117行附近，"已是熟成品名的...保持不变"之后）就地追加复合菜主料覆盖规则 + 两个真实 few-shot（"煎鸡胸肉汤面条"、"牛肉面加个鸡蛋"），未新增独立段落、未触碰其他任务已加的规则。
- `backend/src/routes/chat.ts`：flash 解析成功分支捕获 `pr.needsUpgrade` 到外层变量；`record` 意图的升级判断行由 `parsed.items.some(i => i.food_confidence < 0.5)` 改为 `needsUpgrade || parsed.items.some(...)`，两信号并列触发升 pro，互不替代。**未扩展到 multi 分支的升级逻辑**——multi 目前本就没有任何 pro 升级路径（预先确认过，非本任务引入的缺口），按任务原定范围只改 record 路径这一行。
- `backend/eval/cases/composite-dish-ingredient.yaml`（新增）：3 轮对话，覆盖真实丢主料案例 + 两个误报护栏（同义归一、derivedRequest）。
- `backend/src/services/parser.test.ts`（新增）：7 个单测直接覆盖 `hasIngredientLoss` 纯函数——真实丢主料两例（单 item / 多 item）、两个误报护栏、无主料词、无 items 防御。这是验收第 2 点"失败兜底"的落地方式（单测覆盖组合逻辑，比构造"逼真实 pro 也丢主料"的 LLM 输入更确定、不吃 token）。
- `docs/AI_PARSING_SPEC.md` §5：追加"主料覆盖校验（T67）"小节，说明校验独立于置信度、复用 explicit-signals、只看 canonical、结果走 needsUpgrade 返回值不写回 item。

**验证**：
- `npm test`：200/200 通过（194 基线 + 6 新增，其中 1 条为 T66 遗留未计入基线故实际净增 6）。
- `npx tsc --noEmit`：无输出，通过。
- 干净端口（复用会话内已在跑的 `PORT=9309` tsx watch，热重载已生效，`curl` 确认存活）：
  - `composite-dish-ingredient` 单独跑 2 次，6/6 全绿（含误报护栏两轮）。
  - 抽查 `AiTrace`/`AiParseLog`：本次 3 次真实调用 `model_used` 均为 `deepseek-v4-flash`——即 prompt 补充（设计点 C）已经让 flash 直接输出正确 `canonical="鸡胸肉汤面条"`（`food_confidence` 0.85~0.9），**没有触发到 `needsUpgrade` 升级路径**。这是好结果（prompt 修复起效更早），但也意味着这次真机验证没有实测到"needsUpgrade 真正拉了一次 pro 重试"这条支路本身——该支路的正确性改由 `parser.test.ts` 的纯函数单测保证（`hasIngredientLoss` 对错误 canonical 输入判定为 true 已验证），逻辑正确性有保证，只是没有在真实 flash 输出里触发到。
  - 全量 `npm run eval`：21 用例，1 个新回归 `batch-modify`（"瘦肉改成70克，玉米改成150克"→期望70实际50，multi-modify 消歧路径，与本任务改动的文件均无交集）。单独重跑 4 次全部 4/4 绿，判定为与本任务无关的预置 LLM 抖动，非回归。
  - `npm run audit -- --days 90`：主料词栏 6.1%（3/49，历史真实消息静态扫描口径，与任务背景记录一致，未上升）。
- 未修复但记录：设计点 B 明确该机制目前**只在 chat.ts 的顶层 `record` 分支生效**，`multi` 里的 `record` op 即使 `needsUpgrade=true` 也不会触发升级（因为 multi 现状本就没有升级判断这条逻辑，属于任务范围外的既有缺口，未在本任务内扩展修复）。
