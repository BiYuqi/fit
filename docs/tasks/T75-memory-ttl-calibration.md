# T75 — 记忆时效标定：`expires_at` 对临时状态是死代码，λ 差一个数量级（记忆时效 M2）

**状态**：⬜待办
**目标**：`context_state` 是"临时状态"，但当前一条自称「**最近3天**排便不畅」的记忆要 **42 天**才掉出 ACTIVE。表和提取 schema 都有 `expires_at`，可它**只对 `type=goal` 生效**——给临时状态设过期时间等于没设。把 TTL 变成真正起作用的机制，并把 λ 从"季级"重标到"周级"。

**依赖**：**T74 必须先做完**（理由见"为什么排在 T74 之后"）。
**关注文档**：`MEMORY_SPEC.md` §3（λ 与阈值表）、§5.2（decay 公式）、§8.1（双阈值滞回）——本任务会改动这三处的**参数定义**，改完要保证规范和代码一致。

## 背景（2026-07-27 真机，账号 outoftoken）

`recent_constipation`「最近3天排便不畅」写于 **07-12**，到 **07-27** 依然 `ACTIVE`，被注入上下文，AI 于是说"加上你最近排便不畅，肚子看起来会更鼓"。用户回："我排便正常了，你是不是记错了"。

**T74 修的是"用户否认时撤不掉"。本任务修的是"用户压根没再提，它自己也不会消失"**——绝大多数过时的临时状态不会等来一句否认，用户只会觉得这 AI 记性有毛病。

### 数学：42 天

```
score = llm_confidence × type_weight × importance × rep_boost(1) × decay(t)
      = 0.90 × 0.88 × 1.0 × 0.70 × exp(-0.005 t)
      = 0.5544 × exp(-0.005 t)

掉到 ACTIVE_DOWN(context_state)=0.45  →  t = ln(0.5544/0.45)/0.005 ≈ 41.7 天
掉到 ARCHIVED 底线 0.40              →  t = ln(0.5544/0.40)/0.005 ≈ 65 天
```

`MEMORY_SPEC §3` 把 `context_state` 的衰减定为"**季级**"（λ=0.005，"约 6 个月衰减到 ~0.4"），设计时想的是"出差中"、"备赛恢复期"这类**周到月**尺度的环境。但用户真正说出口的是「最近**3天**排便不畅」、「最近**3天**未进行有氧运动」——**日尺度**。规范假设的时间尺度和用户实际语料差了一个数量级，λ 是照假设标的。

### `expires_at` 是死代码

```ts
// memory-store.ts  attachScore()
const expired =
  type === "goal" &&                    // ← 只有 goal
  row.expires_at != null &&
  new Date(row.expires_at as string) <= now;
```

三重失效，缺一不可地凑齐了：

1. `attachScore` 里 `expired` 的判定**硬编码 `type === "goal"`**；
2. `computeScore` 里的惩罚同样 `if (params.expired && params.type === "goal")` **又判了一次 goal**；
3. `loadActiveMemories` 的三段检索 SQL **完全不看 `expires_at`**——就算 score 被罚了，只要 `state` 还是 ACTIVE 就照样捞出来注入。

所以一条 `context_state` 即使带着 `expires_at='2026-07-15'`，在 07-27 依然会被原样注入上下文。

而且它根本不会带：`FULL_EXTRACT_PROMPT` 的提取规则第 7 条明写「**`expires_at` 仅 type=goal** 且用户给了时间限定时填写 ISO date，否则 null」——**规范、prompt、评分、检索四处一致地把 TTL 锁死在 goal 上**，这不是漏实现，是一个贯穿的设计选择，现在被真实语料证伪了。

### 两个附带的坑（顺手修，别留着）

**规范自相矛盾**：`MEMORY_SPEC` 有**两张打架的阈值表**——§3 是单阈值（constraint 0.45 / preference 0.50 / habit 0.55 / context_state 0.50 / goal 0.60），§8.1 是双阈值滞回（0.48-0.40 / 0.55-0.45 / 0.58-0.48 / 0.55-0.45 / 0.65-0.55）。代码实现的是 §8.1。`memory-scorer.test.ts` 里已经有注释在解释这个差异（"与 §5.4 场景文字的 ACTIVE ✓ 有差异"），也就是说**写测试的人当时就发现了，但选择了绕开而不是修**。按 CLAUDE.md 引用规则「同一信息只在一处定义」，§3 表里的"ACTIVE 阈值"列应该删掉、改成指向 §8.1；§5.4 的场景算例按双阈值重算。

**`updateAccessTime()` 是个定时炸弹**：这个函数在 `memory-store.ts` 定义了，**全代码零调用**。而 `MEMORY_SPEC` 说 `last_accessed_at` 是"上次被**注入**或更新的时间"——也就是规范要求检索时调它。**千万别照规范补上这个调用**：一旦注入就刷新 `last_accessed_at`，任何被注入过的记忆 `decay` 永远重置回 1.0，陈旧记忆将**永生**，而且越是被反复注入的（也就是最影响对话的那些）越不会消失。当前"没实现"恰好是对的。本任务要把这个函数**删掉**，并在 `MEMORY_SPEC §5.2` 把 Δt 基准明确改成"**上次被用户提及/更新**的时间（不含系统注入）"，把这个反直觉的决定写下来，免得下一个人"补全"它。

## 必须先定的口径（实现前确认，别自己拍）

### 口径 1：TTL 优先于 λ，λ 只做兜底

不要靠调 λ 一把梭。λ 是**类型级**的常数，它不可能知道「最近3天排便不畅」比「最近在备赛」短得多——**时间尺度信息在 content 里，只有提取时的 LLM 看得见**。所以：

- **主机制**：`context_state`（以及 `goal`）提取时产出 `expires_at`，检索时过期即不注入
- **兜底**：LLM 没给 `expires_at` 时，后端按类型填**默认 TTL**；λ 负责的是"没过期但久了也该淡"

### 口径 2：具体参数（已拍板，别再自由发挥）

| 项 | 现值 | 新值 | 依据 |
|---|---|---|---|
| `LAMBDA.context_state` | 0.005 | **0.015** | 到 WEAK ~14 天、到 ARCHIVED ~22 天。仍慢于 goal(0.02)，保住 §3 "context_state 比 goal 衰减慢"的定性区分，但从季级改成周级 |
| `context_state` 默认 TTL | 无 | **14 天** | 与 λ 到 WEAK 的时间对齐，两条机制不打架 |
| `goal` 默认 TTL | 无（仅用户给了才填） | **30 天** | "这个月戒糖"没写日期时的合理边界 |
| `preference` / `habit` / `constraint` TTL | — | **不引入** | 这三类的语义就是"长期"，加 TTL 是把 T74 的失效通道重复实现一遍 |

**过期后怎么处理**：`expires_at <= now` 的记忆**直接不进检索结果**（SQL 层过滤），而不是只罚 score。理由：罚分后能不能压到阈值下取决于原始分高低，是不确定的；而"过期"是个确定的事实，就该有确定的行为。现有 goal 的 `× 0.2` 惩罚保留（它是"过期但还没被 cron 归档"这个窗口期的软处理），但**不再是唯一手段**。

### 口径 3：`rep_boost(1) = 0.70` 的刀刃阈值——本任务**不动**

首次记忆一律被 `rep_boost(1) = 1 - e^{-1.2} = 0.70` 压到阈值线附近，谁在线上谁在线下取决于 `llm_confidence` 的 0.05 抖动（T74 背景里算过：0.554 vs 0.524，一个 ACTIVE 一个 WEAK）。这是真问题，但**本任务不碰**：

T74 会修掉 `ON CONFLICT DO UPDATE` 里 `state` 用硬编码 `repetition_count: 1` 重算的 bug。**在那个 bug 还在的时候调 `rep_boost` 或 `ACTIVE_UP`，等于在一个算错的输入上标定参数**——先让输入正确，再看阈值到底需不需要动。做完 T75 跑一段真实数据后单独评估，别在本任务里顺手改（铁律 10）。

## 设计要点

> **定位方式**：文中行号是写作时快照，一律用给出的特征字符串搜索定位。

### A. `expires_at` 全类型生效（`src/services/memory-scorer.ts` + `memory-store.ts`）

1. `computeScore` 的 `if (params.expired && params.type === "goal")` → 去掉 type 判断，`expired` 对所有类型都罚 `× 0.2`。`ScoreParams.expired` 的注释（"仅 type=goal 且 expires_at 已过时设置 true"）同步改。
2. `attachScore` 的 `const expired = type === "goal" && ...` → 去掉 type 判断。
3. `loadActiveMemories` 的**三段检索 SQL** 全部加 `AND (expires_at IS NULL OR expires_at > now())`。三段都要加——`constraint` 那段虽然不会有 TTL，加上是无害的一致性（且防止将来有人给 constraint 填了 TTL 却发现不生效）。

### B. 默认 TTL（`src/services/memory-store.ts` `upsertMemory`）

在 `upsertMemory` 里，`candidate.expires_at` 为空且 `type ∈ {context_state, goal}` 时按口径 2 填默认值。**放在 store 层不放在 extract 层**——两条提取路径（quick/full）都要享受，放 store 层只写一次。

`ON CONFLICT DO UPDATE` 里现在是 `expires_at = EXCLUDED.expires_at`：这意味着用户**重新提起**一条临时状态时 TTL 会顺延，符合直觉（"还在出差"），保留。

### C. 提取 prompt 放开 TTL（`src/services/memory-extract.ts`）

> **⚠️ 两份 prompt 都要改**：`QUICK_EXTRACT_PROMPT` 和 `FULL_EXTRACT_PROMPT`。

`FULL_EXTRACT_PROMPT` 提取规则第 7 条「expires_at 仅 type=goal…」**就地改写**为：`context_state` 和 `goal` 都填 `expires_at`；**按 content 里的时间线索估**——"最近3天"→3-7天，"这周"→本周末，"最近"（无具体跨度）→留空走默认，"备赛期"→留空。`QUICK_EXTRACT_PROMPT` 现在**完全没提 `expires_at`**（返回 JSON 的示例里也没有这个 key），要补上同样的规则和示例。

few-shot 用真实语料：「最近三天排便不畅」→ `{type:"context_state", entity:"recent_constipation", expires_at:"<今天+7天>"}`。

> 注意 prompt 里要不要注入"今天是几号"——`expires_at` 是绝对日期，模型必须知道当天日期才能算。**先确认现有 prompt 组装时有没有喂当前日期**（`compressContext` 的 L0 时间段是 chat 路径的，提取路径是独立调用），没有就补，否则模型只能瞎猜年份。

### D. 删掉 `updateAccessTime()` + 写下 Δt 基准的决定

- 删 `memory-store.ts` 里的 `updateAccessTime`（零调用的死代码，铁律 12）
- `MEMORY_SPEC §5.2` 把 `last_accessed_at` 的定义从"上次被**注入**或更新的时间"改成"上次被**用户提及或更新**的时间"，并加一句反直觉决定的理由：**系统注入不刷新它**，否则被反复注入的陈旧记忆会永生
- `prisma/schema.prisma` 里 `last_accessed_at` 的行内注释同步改

### E. 规范收口（`docs/MEMORY_SPEC.md`）

1. §3 类型表里的「ACTIVE 阈值」列**删掉**，替换成一句"阈值见 §8.1（双阈值滞回，唯一定义处）"
2. §3 的 λ 列与下方"λ 的含义"段按口径 2 更新（context_state 0.005 → 0.015，"约 6 个月"→"约 2 周到 WEAK"）
3. §2.2 表里 context_state 的 λ 描述"大（月级）"、§3 小节里"中等（λ=0.005，约半年自然消退）"一并改成周级
4. §3 的过期机制行：context_state 从"衰减 + expires_at"（**这行其实已经写对了，是实现没跟上**）保持，goal 保持，其余不动
5. §5.4 的场景算例按 §8.1 双阈值重算（场景 4 context_state 首次：0.52 < ACTIVE_UP 0.55 → **WEAK**，现在文字写的是 "ACTIVE ✓"）
6. `memory-scorer.test.ts` 里那两处"与 §5.4 场景文字有差异"的绕开式注释**删掉**——规范改对之后就没有差异了

## 验收

**必须真机验证。** 起干净端口：`PORT=9309 npm run dev`。

1. 说「最近三天排便不畅」→ 库里该行 `expires_at` 非空且在 ~7 天内
2. 手动把某条 `context_state` 的 `expires_at` 改到昨天 → 下一轮对话**不再注入**（查 `AiTrace.prompt_messages` 确认，别只看 AI 回复）
3. 说「最近压力大」（无时间线索）→ `expires_at` = 今天 +14 天（默认 TTL 生效）
4. 说「这周控碳水」→ `goal` 的 `expires_at` 是本周末，不是 +30 天（LLM 估的优先于默认）
5. 造一条 15 天前的 `context_state`（`created_at`/`last_accessed_at` 都改）→ 跑一次 `recalcAndPrune` → `state` 变 `WEAK`（λ=0.015 生效）
6. `constraint` 记忆在同样 15 天后**仍是 ACTIVE**（λ=0，别误伤）
7. `grep -rn "updateAccessTime" src` 零结果
8. `npm test` 全绿（`memory-scorer.test.ts` 的期望值随 λ 变化要更新——**更新期望值时对着规范改，不是对着实测输出改**）
9. `npm run eval` 不退化
10. `MEMORY_SPEC.md` 里搜不到第二张阈值表

## 为什么排在 T74 之后

两个任务都动记忆的生命周期，但**方向相反且必须有序**：

- **T74 = 显式失效**（用户说"不是这样"→ 立刻撤销）。它同时修掉 `ON CONFLICT` 里 state 用硬编码 `rep=1` 重算的 bug，以及把冲突键从 `(user_id,type,entity,content)` 收成 `(user_id,type,entity)`。
- **T75 = 自然失效**（没人说话，时间到了自己淡出）。它调的是 λ 和 TTL——**参数标定必须建立在正确的输入之上**。T74 没做完就调参，等于在一个 state 算错、同 entity 散落多行的库上标定，调出来的数只会是噪声的镜像。

反过来只做 T75 不做 T74 也不行：TTL 只能处理"用户没再提"，处理不了"用户明确说你记错了"——今晚那两次否认，靠等 14 天是等不来的。

## 提示词

```
做 docs/tasks/T75-memory-ttl-calibration.md。

前置：确认 T74 已 ✅。没做完就先做 T74（理由见任务文件末尾"为什么排在 T74 之后"）。

先读 CLAUDE.md 铁律和 docs/MEMORY_SPEC.md §3/§5.2/§8.1，再读任务文件全文。
口径 2 的参数已经拍板，直接用，不要自由发挥。口径 3 明确说了 rep_boost 和
ACTIVE_UP 本任务不动——别顺手调。

三个容易漏的点：
1. expires_at 失效是三重的（computeScore / attachScore / 三段检索 SQL），全都要改；
2. QUICK 和 FULL 两份提取 prompt 都要改，QUICK 现在完全没提 expires_at；
3. 提取 prompt 得知道"今天是几号"才能算绝对日期，先确认有没有喂。

updateAccessTime 是删不是补——任务文件里写了为什么，照做。

做完按验收清单逐条真机验证：PORT=9309 npm run dev。别动 :9300。
验收通过后把状态改成 ✅ 于两处：本文件顶部 + docs/TASKS.md 该行（含顶部进度计数）。
```
