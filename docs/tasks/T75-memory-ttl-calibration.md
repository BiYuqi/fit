# T75 — 记忆时效标定：`expires_at` 对临时状态是死代码，λ 差一个数量级（记忆时效 M2）

**状态**：🔄进行中（2026-07-28）——代码与文档已完成，**验收 11（`npm run eval` 不退化）未确认**，卡在 DeepSeek 余额耗尽

> **落地记录（2026-07-28）**
>
> 代码/文档/单测全部完成，验收 1–10、12 逐条真机通过（起 `PORT=9309` 干净端口，`:9300` 未触碰）。新增回归用例 `eval/cases/memory-ttl.yaml`，单跑绿。
>
> **实现中发现修订块也没堵全的一条**：§A.3 只堵了检索 SQL 那一侧，但 §A.1 把过期惩罚 `× 0.2` 放开到全类型后，一条挂着过期时间的 medical constraint 会被 `recalcAndPrune` 打成 **WEAK**——`decideStateWithFloor` 确实拦住了 ARCHIVED，可检索 SQL 一律 `state = 'ACTIVE'`，**WEAK 就已经不注入了**。真机上 `peanut`「花生过敏」实测被降到 WEAK，验收 7 在 cron 这条路上是漏的。
> 底线要守的是「**不会自动停止注入**」，不是「不会 ARCHIVED」。已在 `attachScore` 的 `expired` 判定里豁免 medical，与检索层豁免同源，复验通过。
>
> **另一个记一笔、不在本任务范围的问题**：提取器**不复用**【已有记忆】里已有的 entity。真机实测「我最近又出差了，三餐不规律」在 `business_trip` 明明就在喂进去的列表里、且它是受控词表里的词的情况下，照样新建了 `recent_business_trip` + `irregular_meals` 两条。这也是全库 `upcoming_social_event` / `upcoming_event` / `upcoming_gathering` 这类近义 entity 满天飞的根因。因此 `eval/run.ts` 的 `db.memory` 断言放开成「`entity` 省略时按 `type` 匹配任意一条」——断言具体名字等于赌模型的措辞。
>
> **未完成的一条**：完整 `npm run eval` 第一轮跑完是「新回归 2」，但我只留了汇总没留明细；准备复跑定位时 **DeepSeek 余额耗尽**（`is_available: false`，余额 -0.22 元），此后所有 LLM 调用一律 402。因此**无法确认那 2 条红是哪两个用例、是否与 T75 有关**。充值后需复跑一次完整 eval 才能收尾——在那之前本任务不标 ✅。
>
> 注意：余额耗尽同时意味着**常驻 prod `:9300` 现在也答不了任何一句话**（每次对话都会 402）。
**目标**：`context_state` 是"临时状态"，但当前一条自称「**最近3天**排便不畅」的记忆要 **42 天**才掉出 ACTIVE。表和提取 schema 都有 `expires_at`，可它**只对 `type=goal` 生效**——给临时状态设过期时间等于没设。把 TTL 变成真正起作用的机制，并把 λ 从"季级"重标到"周级"。

**依赖**：**T74 必须先做完**（理由见"为什么排在 T74 之后"）。T74 已于 2026-07-28 ✅。
**关注文档**：`MEMORY_SPEC.md` §3（λ 与阈值表）、§5.2（decay 公式）、§8.1（双阈值滞回）——本任务会改动这三处的**参数定义**，改完要保证规范和代码一致。

> **2026-07-28 复核修订**：T74 完成后对着真机库复核了本任务，改了 4 处会让它「做完等于没做」或**把系统改坏**的地方——口径 2 的 goal 行、§A.3 的 constraint 段、口径 4（过期后 `state` 归属）、口径 5（相对天数替代绝对日期）。修订原则是**最小化对线上稳定运行的影响**：能不动的常数不动、能不加的 SQL 条件不加、能不让模型算的不让模型算。逐条理由写在各自小节的「2026-07-28 修订」块里。

## 背景（2026-07-27 真机，账号 outoftoken）

`recent_constipation`「最近3天排便不畅」写于 **07-12**，到 **07-27** 依然 `ACTIVE`，被注入上下文，AI 于是说"加上你最近排便不畅，肚子看起来会更鼓"。用户回："我排便正常了，你是不是记错了"。

**T74 修的是"用户否认时撤不掉"。本任务修的是"用户压根没再提，它自己也不会消失"**——绝大多数过时的临时状态不会等来一句否认，用户只会觉得这 AI 记性有毛病。

### 更硬的证据（2026-07-28 复核实测）

上面那条 `recent_constipation` 已经被 T74 归档了，**它不再是本任务的证据**。做 T75 之前重查 `outoftoken`，ACTIVE 的 `context_state` 只剩两条，两条都过时：

| entity | content | 写入 | 已过 |
|---|---|---|---|
| `lower_back_discomfort` | 腰不舒服 | 07-07 | **21 天** |
| `weight_loss_plateau` | 一两周没降体重了 | 07-10 | **18 天** |

第二条才是本任务真正的靶子：07-27 用户说了体重降了，系统把它写进 `weight_plateau_broken`「体重从78公斤平台期出现下降」——**新事实 WEAK（进不来），被它推翻的旧事实 ACTIVE（还在注入）**。用户全程没说过"你记错了"，只是陈述了新情况，所以 **T74 的作废通道抓不到它，只有 TTL 抓得到**。

全库另外两个数字：`expires_at` 非空 **0 行**（字段建了从没写过）、`updateAccessTime` 调用方 **0 处**（两处死代码属实）。

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
| `goal` 默认 TTL | 无（仅用户给了才填） | **不引入**（改） | 见下方修订块——goal 在数学上进不了 ACTIVE，给它填默认 TTL 是给死代码加死代码 |
| `preference` / `habit` / `constraint` TTL | — | **不引入** | 这三类的语义就是"长期"，加 TTL 是把 T74 的失效通道重复实现一遍 |

> **2026-07-28 修订：删掉 `goal` 默认 TTL = 30 天**
>
> goal 首次记忆的分数上限是 `0.9 × TYPE_WEIGHT.goal(0.80) × 1.0 × rep_boost(1)=0.70 = 0.504`，而 `ACTIVE_UP.goal = 0.65`。**首次 goal 记忆在数学上不可能进 ACTIVE**——库里 goal 共 1 条、ACTIVE 0 条，实锤。
>
> 就算用户把同一个目标说满两遍（`rep_boost(2)=0.91` → 0.655 险过线），`λ.goal = 0.02` 会让它 **8.7 天**跌回 `ACTIVE_DOWN 0.55`，**30 天的 TTL 永远轮不到触发**。
>
> 也就是说这一行给的是"一个永远不会被检索的类型"的过期时间——和本任务开头批判的 `expires_at` 死代码是同构的。LLM 主动给出的 `expires_at`（如"这周控碳水"）照常写入并生效（§A 的过滤对 goal 有效），只是**后端不再兜底填默认值**。goal 真正的问题是 `ACTIVE_UP=0.65` 太高，那属于口径 3，不在本任务。

过期后的行为见**口径 4**，TTL 的表示形式见**口径 5**。

### 口径 3：`rep_boost(1) = 0.70` 的刀刃阈值——本任务**不动**

首次记忆一律被 `rep_boost(1) = 1 - e^{-1.2} = 0.70` 压到阈值线附近，谁在线上谁在线下取决于 `llm_confidence` 的 0.05 抖动（T74 背景里算过：0.554 vs 0.524，一个 ACTIVE 一个 WEAK）。这是真问题，但**本任务不碰**：

T74 会修掉 `ON CONFLICT DO UPDATE` 里 `state` 用硬编码 `repetition_count: 1` 重算的 bug。**在那个 bug 还在的时候调 `rep_boost` 或 `ACTIVE_UP`，等于在一个算错的输入上标定参数**——先让输入正确，再看阈值到底需不需要动。做完 T75 跑一段真实数据后单独评估，别在本任务里顺手改（铁律 10）。

> **2026-07-28 修订：结论仍是本任务不动，但数据已经把答案摆出来了，先记在这里别丢**
>
> T74 已完成，输入正确了。复核全库 40 条 `context_state`，**无一例外**：
>
> - `llm_confidence ≥ 0.90` → `0.9 × 0.88 × 0.70 = 0.554 > ACTIVE_UP 0.55` → **ACTIVE**
> - `llm_confidence ≤ 0.85` → `0.85 × 0.88 × 0.70 = 0.524 < 0.55` → **WEAK**
>
> 一条首次记忆能不能被检索到，**100% 由 LLM 那 0.05 的置信度抖动决定**，语义完全不参与。`daily_badminton_30min`（用户 07-27 亲口纠正的事实，conf 0.9 但 habit 权重 0.85 → 0.536 < `ACTIVE_UP.habit` 0.58）到今天仍是 WEAK、仍不注入。
>
> **为什么还是不并进 T75**：动这个的最小改法也要重标 5 个类型 × 2 个阈值 = 10 个常数（`ACTIVE_UP`/`ACTIVE_DOWN` 必须一起动才能保住滞回死区），外加 `MEMORY_SPEC §8.1` 唯一定义处、`memory-scorer.test.ts` 全部期望值。而 T75 本体只动 1 个 λ + 1 个默认 TTL + 1 段检索 SQL。**把两者合并会让改动面翻五倍，且两组参数的效果在实测里互相掩盖，出了问题分不清是谁的**——与本次修订的「最小化影响稳定运行」原则直接冲突。
>
> **但要认清 T75 单独上线的净效果**：记忆消失得更快了，该记住的**依然进不来**。用户体感可能是"AI 更健忘了"而不是"AI 不说错话了"。所以 T75 跑完一周真实数据后**必须**立刻评估这一条，别让它无限期躺着——届时新开任务，输入是本块的两条判据加一周的 `state` 分布。

### 口径 4：过期只挡检索，`state` 交给既有 cron——不新增任何调度（2026-07-28 新增）

`expires_at <= now` 的记忆**直接不进检索结果**（SQL 层过滤），而不是只罚 score。理由：罚分后能不能压到阈值下取决于原始分高低，是不确定的；而"过期"是个确定的事实，就该有确定的行为。现有的 `× 0.2` 惩罚保留并放开到全类型（它是"过期但还没被 cron 归档"这个窗口期的软处理），但**不再是唯一手段**。

由此产生一个必须明确接受的后果，别当 bug 去修：

- **`state` 与"实际是否生效"最长会不一致 24 小时**。检索层已经不注入它了，但 `state` 还是 `ACTIVE`，记忆中心也照常显示"生效中"，要等 `cron.schedule("0 3 * * *")` 的 `recalcAndPrune` 跑到才落库。
- **过期记忆会跳过 WEAK 直接 ARCHIVED**：`0.5544 × 0.2 = 0.11 < 0.40`。这是刻意的——过期是确定事实，不需要滞回缓冲。
- **medical 例外仍然生效**：T74 的 `decideStateWithFloor` 会把 medical 拦在 `WEAK`，不会 ARCHIVED。与口径 3（T74）的医疗底线一致，不用额外处理。

**不要为了消掉这 24 小时去加新 cron、加实时 state 同步、或改记忆中心 UI**——那是为一个用户几乎察觉不到的窗口引入新的定时任务和新的写路径，收益远小于风险。把这段窗口写进 `MEMORY_SPEC §5.2` 的实现注记即可。

### 口径 5：TTL 走**相对天数**，绝对日期由后端算——模型不碰日历（2026-07-28 新增）

**提取 schema 的字段改成 `expires_in_days`（正整数或 null），后端 `upsertMemory` 换算成 `expires_at` 落库。DB 列名 `expires_at` 不变。**

原方案是让 LLM 直接输出 ISO 绝对日期。实测确认了它必坏：

1. `quickExtract` 的入参只有 `QUICK_EXTRACT_PROMPT + 已有记忆段`（system）和用户原话（user）——**一个字的日期都没喂**；
2. 而 `FULL_EXTRACT_PROMPT` 的 goal 小节里**硬编码了两个示例日期** `2026-07-14` / `2026-07-31`。

模型不知道今天几号，眼前又摆着两个 7 月的样例，最可能的行为是照抄年月 → 产出一个**已经过去的日期** → 叠加 §A 的 SQL 过滤 = **新记的 `context_state` 一出生就是过期的，永不注入，零报错、零日志**。症状和现在完全相反，但一样难查，而且是本任务唯一能把系统改坏的路径。

改成相对天数之后：

- 不需要往两份 prompt 注入"今天是几号"（**少一处每次调用都要拼的动态内容，prompt 反而更短、更可缓存**）；
- `FULL_EXTRACT_PROMPT` 里那两个硬编码日期**顺手删掉**，改成 `expires_in_days: 7` / `expires_in_days: 30` —— few-shot 里从此没有会过期的字面量；
- 模型只需做"最近3天 → 7"这种量级判断，不做日历算术，这是它稳定能做对的事；
- 后端换算时把 date-only 语义统一成**当天本地时 23:59:59**，避开 `new Date("2026-08-11")` 被解析成 UTC 午夜、在 UTC+8 下提前 16 小时失效的坑。

`ExtractResultSchema` 里 `expires_at` 字段**直接改名，不留兼容别名**（铁律 12）。

## 设计要点

> **定位方式**：文中行号是写作时快照，一律用给出的特征字符串搜索定位。

### A. `expires_at` 真正生效（`src/services/memory-scorer.ts` + `memory-store.ts`）

1. `computeScore` 的 `if (params.expired && params.type === "goal")` → 去掉 type 判断，`expired` 对所有类型都罚 `× 0.2`。`ScoreParams.expired` 的注释（"仅 type=goal 且 expires_at 已过时设置 true"）同步改。
2. `attachScore` 的 `const expired = type === "goal" && ...` → 去掉 type 判断。
3. `loadActiveMemories` 的检索 SQL 加 `AND (expires_at IS NULL OR expires_at > now())`——**只加在 `context_state + goal` 那一段**（`type IN ('context_state','goal')` 的那条查询）。

> **2026-07-28 修订：原文写的"三段都加，`constraint` 那段加上是无害的一致性"——不是无害，是给 T74 的医疗底线开后门**
>
> T74 刚立的规矩是「医疗类记忆绝不自动消失，只有用户能在记忆中心手动删」，并为此把底线焊进了 `decideStateWithFloor()`。给 `constraint` 段加上过期过滤，等于在这条底线旁边开了一条**完全绕过它**的路径：只要有任何来源给一条 medical constraint 写进了 `expires_at`（提取 prompt 抽风、将来某个任务、手工数据修复），SQL 会**静默地不注入这条过敏记忆**——而它的 `state` 还是 `ACTIVE`，记忆中心照常显示"生效中"，`decideStateWithFloor` 也拦不住（它管的是 state，不是检索）。一条被静默忽略的过敏记忆，代价是本项目里最高的那一类。
>
> `preference` / `habit` 两段同理不加：口径 2 明确这两类不引入 TTL，加了就是一个恒真条件，只会让后来的人以为这里有 TTL 语义。
>
> **只加一段**，也正好是本任务对检索热路径影响最小的写法。

若将来真要给 `constraint` 开 TTL，前置条件是先想清楚怎么和 T74 的医疗底线共存（最低限度：`OR importance_class = 'medical'`），那是另一个任务的事，不在本任务范围。

### B. 默认 TTL（`src/services/memory-store.ts` `upsertMemory`）

`upsertMemory` 在 store 层做两件事（**放 store 层不放 extract 层**——两条提取路径 quick/full 都要享受，只写一次）：

1. **换算**：`candidate.expires_in_days` 非空 → `expires_at = 今天 + N 天` 的**本地时 23:59:59**（口径 5）；
2. **兜底**：`expires_in_days` 为空且 `type === "context_state"` → 填 **14 天**。`goal` 不兜底（口径 2 修订），其余类型不填。

`ON CONFLICT DO UPDATE` 里现在是 `expires_at = EXCLUDED.expires_at`：这意味着用户**重新提起**一条临时状态时 TTL 会顺延，符合直觉（"还在出差"），保留。

> 注意它和 T74 遗留的 quick/full **双路径重复写**叠加后的行为：同一句话会被 upsert 两次，第二次同样顺延 TTL。结论是无害的（顺延到同一天），**但别在本任务里顺手去修双写**——那牵扯 `MEMORY_SPEC §6` 从未实现的 24h 去重，是独立问题。

### C. 提取 prompt 放开 TTL（`src/services/memory-extract.ts`）

> **⚠️ 两份 prompt 都要改**：`QUICK_EXTRACT_PROMPT` 和 `FULL_EXTRACT_PROMPT`。

按口径 5，模型输出的是 **`expires_in_days`（正整数或 null）**，不是绝对日期。

`FULL_EXTRACT_PROMPT` 提取规则第 7 条「expires_at 仅 type=goal…」**就地改写**为：`context_state` 和 `goal` 都填 `expires_in_days`；**按 content 里的时间线索估**——"最近3天"→7，"这周"→到本周末还剩几天，"最近"（无具体跨度）→ null 走默认，"备赛期"→ null。`QUICK_EXTRACT_PROMPT` 现在**完全没提 TTL**（返回 JSON 的示例里也没有这个 key），要补上同样的规则和示例。

few-shot 用真实语料：「最近三天排便不畅」→ `{type:"context_state", entity:"recent_constipation", expires_in_days:7}`。

> **必做的前置清理**：`FULL_EXTRACT_PROMPT` 的 goal 小节里硬编码着 `expires_at:"2026-07-14"` / `"2026-07-31"` 两个字面日期，改成 `expires_in_days:7` / `expires_in_days:30` 一并删掉。留着它们是本任务最危险的失败模式——理由见口径 5，别跳过。

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

1. 说「最近三天排便不畅」→ 库里该行 `expires_at` 非空、**是未来时间**、且在 ~7 天内（"是未来时间"是口径 5 那个失败模式的直接探针，别省）
2. 手动把某条 `context_state` 的 `expires_at` 改到昨天 → 下一轮对话**不再注入**（查 `AiTrace.prompt_messages` 确认，别只看 AI 回复）
3. 说「最近压力大」（无时间线索）→ `expires_at` = 今天 +14 天（默认 TTL 生效）
4. 说「这周控碳水」→ `goal` 的 `expires_at` 是本周末（LLM 给的 `expires_in_days` 生效）；再说一句没有时间线索的目标 → `expires_at` **为 null**（goal 不兜底，口径 2 修订）
5. 造一条 15 天前的 `context_state`（`created_at`/`last_accessed_at` 都改）→ 跑一次 `recalcAndPrune` → `state` 变 `WEAK`（λ=0.015 生效）
6. `constraint` 记忆在同样 15 天后**仍是 ACTIVE**（λ=0，别误伤）
7. **医疗底线没被 §A.3 绕过**：给一条 `importance_class='medical'` 的 constraint 手工写上昨天的 `expires_at` → 下一轮对话**仍然注入**（查 `AiTrace.prompt_messages`）。这条守的是 T74 的口径 3，改检索 SQL 时最容易踩
8. `grep -rn "updateAccessTime" src` 零结果
9. `grep -rn "2026-07" src/services/memory-extract.ts` 零结果（prompt 里不该再有字面日期）
10. `npm test` 全绿（`memory-scorer.test.ts` 的期望值随 λ 变化要更新——**更新期望值时对着规范改，不是对着实测输出改**）
11. `npm run eval` 不退化（已知 `modify-disambig` 有既有抖动，与本任务无关，红了单独复跑确认）
12. `MEMORY_SPEC.md` 里搜不到第二张阈值表

## 为什么排在 T74 之后

两个任务都动记忆的生命周期，但**方向相反且必须有序**：

- **T74 = 显式失效**（用户说"不是这样"→ 立刻撤销）。它同时修掉 `ON CONFLICT` 里 state 用硬编码 `rep=1` 重算的 bug，以及把冲突键从 `(user_id,type,entity,content)` 收成 `(user_id,type,entity)`。
- **T75 = 自然失效**（没人说话，时间到了自己淡出）。它调的是 λ 和 TTL——**参数标定必须建立在正确的输入之上**。T74 没做完就调参，等于在一个 state 算错、同 entity 散落多行的库上标定，调出来的数只会是噪声的镜像。

反过来只做 T75 不做 T74 也不行：TTL 只能处理"用户没再提"，处理不了"用户明确说你记错了"——今晚那两次否认，靠等 14 天是等不来的。

## 提示词

```
做 docs/tasks/T75-memory-ttl-calibration.md。

T74 已 ✅。先读 CLAUDE.md 铁律和 docs/MEMORY_SPEC.md §3/§5.2/§8.1，再读任务文件全文。

任务文件里所有标着「2026-07-28」的修订/新增块，是 T74 完成后对着真机库复核
出来的修正（口径 2 / 口径 3 / 口径 4 / 口径 5 / §A.3 共五处），**优先级高于
它们上方的原文**。核心原则是最小化对线上稳定运行的影响：
能不动的常数不动、能不加的 SQL 条件不加、能不让模型算的不让模型算。

口径 2 / 4 / 5 的参数和形式都已拍板，直接用，不要自由发挥。口径 3 说了
rep_boost 和 ACTIVE_UP 本任务不动——数据结论已写在那块里，别顺手调。

四个容易漏的点：
1. expires_at 失效是三重的（computeScore / attachScore / 检索 SQL），全都要改；
   但检索 SQL **只改 context_state+goal 那一段**，constraint 段加了会绕过 T74
   的医疗底线（§A.3 修订块写了为什么，验收第 7 条守这个）；
2. QUICK 和 FULL 两份提取 prompt 都要改，QUICK 现在完全没提 TTL；
3. 模型输出的是 expires_in_days 相对天数，不是绝对日期；FULL prompt 里
   硬编码的 2026-07-14 / 2026-07-31 必须删（口径 5，本任务唯一能把系统改坏的路径）；
4. goal 不填默认 TTL——它在数学上进不了 ACTIVE，填了是死代码。

updateAccessTime 是删不是补——任务文件里写了为什么，照做。

做完按验收清单逐条真机验证：PORT=9309 npm run dev。别动 :9300。
验收通过后把状态改成 ✅ 于两处：本文件顶部 + docs/TASKS.md 该行（含顶部进度计数）。
```
