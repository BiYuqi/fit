# T74 — 记忆失效通道：只进不出，用户否认了也撤不掉（记忆时效 M2）

**状态**：⬜待办　　**优先级：本轨最高**（今晚三次"AI 说错用户的事实"是同一个根因）

**目标**：语义记忆系统当前是**纯 append**——没有任何代码路径能让一条记忆因为"用户否认了"或"状态早就过去了"而失效。`MEMORY_SPEC §5.5 冲突处理`把算法写完整了，T54/T55/T56 三个任务**从来没实现过它**；表里 `valid_to` 字段留着（T54 地基建的洞），**至今零写入**。本任务把 §5.5 落地，并补上规范没覆盖的"纯否认"场景。

**依赖**：无（T54–T56 已完成）。**后续**：T75（时效标定）——两者分工见文末。
**关注文档**：`MEMORY_SPEC.md` §5.5（冲突处理，本任务的规范源）、§6（`valid_from`/`valid_to` 语义）、§11（已知盲区，做完要更新）、`DATA_MODEL.md`（`user_memory` 字段）、`API_SPEC.md`（Memory Center 若新增撤销端点）。

## 背景（2026-07-27 真机，账号 outoftoken，一晚上三次）

| 记忆 | 写入时间 | 今晚 AI 的话 | 用户的回应 |
|---|---|---|---|
| `context_state / recent_constipation`「最近3天排便不畅」 | **07-12** | "加上你最近排便不畅，肚子看起来会更鼓" | **"我排便正常了，你是不是记错了"** |
| `context_state / no_aerobic_exercise`「最近3天未进行有氧运动」 | **07-12** | "把有氧捡回来，每周3-4次30分钟以上的慢跑" | **"我每天都有30分钟的羽毛球"** |
| `context_state / diarrhea`「用户当前处于拉肚子状态」 | **今晚 21:57** | （基于此劝"先把水喝足、等肠胃稳下来"） | **"已经一周了，早就好了"** |

**三条现在全都还在库里，前两条还是 `ACTIVE`。** 用户明确否认了两次，系统一个字段都没动——下次对话还会再说一遍。第三条更糟：它是**今晚刚写进去的一条已经过时的状态**，用户下一句就否认了，但它会继续污染以后每一次对话。

### 双向都堵死了：旧的出不去，新的进不来

今晚用户说出的三条**纠正性事实**全部落成 `WEAK`，而检索 SQL 一律 `state = 'ACTIVE'`（`memory-store.ts` 里 5 处 `WHERE ... AND state = 'ACTIVE'`）：

```
daily_badminton_30min  「每天30分钟羽毛球」          habit          conf 0.90 → WEAK
weight_plateau_broken  「体重从78公斤平台期出现下降」  context_state  conf 0.85 → WEAK
diarrhea               「用户当前处于拉肚子状态」      context_state  conf 0.85 → WEAK
```

算一下就明白：`score = conf × type_weight × importance × rep_boost(1) × decay(0)`，而 `rep_boost(1) = 1 - e^-1.2 = 0.70`。

| 记忆 | 算式 | score | ACTIVE_UP | 结果 |
|---|---|---|---|---|
| `recent_constipation`（07-12 那条陈旧的） | 0.90 × 0.88 × 1.0 × 0.70 | **0.554** | 0.55 | **ACTIVE** ✓ |
| `diarrhea`（今晚新的） | 0.85 × 0.88 × 1.0 × 0.70 | **0.524** | 0.55 | WEAK ✗ |
| `daily_badminton_30min`（今晚新的） | 0.90 × 0.85 × 1.0 × 0.70 | **0.536** | 0.58 | WEAK ✗ |

陈旧那条能进 ACTIVE、纠正那条进不去，差别只有 **0.05 的 `llm_confidence`**。首次记忆一律被 `rep_boost(1)=0.70` 压在阈值线附近，谁在线上谁在线下基本是掷硬币。**这个标定问题归 T75**，但它解释了为什么本任务不能靠"让新记忆盖过旧记忆"来解决——**必须有显式的失效通道**。

### upsert 冲突键的第二重堵塞

```prisma
@@unique([user_id, type, entity, content])   // schema.prisma
```

冲突键**含 `content`**。所以「最近3天排便不畅」和「排便已恢复正常」即使 `type`+`entity` 完全相同，也是**两条独立的行**，`repetition_count` 不会累加、旧行不会被更新。而 `MEMORY_SPEC §5.5` 的算法前提是"当 extraction 产出的 **entity+type** 命中已有记忆时"——**规范和实现的键不是一个键**。

### LLM 已经在报告"这是修正"，代码把它扔了

`MemoryCandidateSchema` 里有 `action: z.enum(["create", "update"])`，提取 prompt 也明确要求 `action: 如同 entity+type 出现在已有记忆中→"update"`。但 `quickExtract` / `fullExtract` 组装 `upsertMemory()` 入参时**根本没传 `action`**——模型辛苦判出来的信号，在应用层被静默丢弃。

## 必须先定的口径（实现前确认，别自己拍）

### 口径 1：纯否认怎么处理（§5.5 没覆盖）

`MEMORY_SPEC §5.5` 处理的是"**新旧两条记忆矛盾**"（旧："爱吃辣"，新："现在不吃辣了"）。今晚用户说的是「我排便正常了，你是不是记错了」——**否定一条旧记忆，但不产生任何值得存的新事实**（"排便正常"是默认状态，不是特征）。走 §5.5 会退化成"提取不出候选 → 什么都不做"，这正是现在的行为。

本任务采用：**提取输出新增一条独立的 `invalidations` 通道**，与 `candidates` 并列：

```ts
const InvalidationSchema = z.object({
  entity: z.string().min(1),          // 要作废的记忆 entity（必须来自喂进去的"已有记忆"列表，不许模型现编）
  type: z.enum([...]),
  reason: z.string(),                 // 用户原话片段，写进 source_text 供追溯
  llm_confidence: z.number().min(0).max(1),
});
const ExtractResultSchema = z.object({
  candidates: z.array(MemoryCandidateSchema).default([]),
  invalidations: z.array(InvalidationSchema).default([]),   // ← 新增
});
```

**为什么不复用 `candidates` 加个 `action:"invalidate"`**：作废的输入形状和创建根本不同（不需要 `content`/`importance_class`，需要的是"指向哪条已有记忆"），塞进同一个 schema 会让两组字段互相 optional，模型更容易填错。

### 口径 2：作废是软删还是降权

三选一，本任务采用第 **2** 种：

1. 直接 `archiveMemory()`（state=ARCHIVED）→ 太硬，模型误判一次就永久丢失用户特征
2. **`valid_to = now()` + `state = 'ARCHIVED'`，但不硬删**——`valid_to` 保留"用户在这个时间点变了"的轨迹（§6 的原意），90 天后由既有的 `deleteExpiredMemories` 周 cron 自然清理。用户想找回，Memory Center 里还能看到
3. score 减半 → 就是 §5.5 里 `opposite` 但置信度不够时的**降级路径**，不是显式否认该有的待遇

**门槛**：只有 `llm_confidence ≥ 0.80` 且 `entity` 确实在喂给模型的已有记忆列表里，才执行作废；否则**只降权不作废**（走 §5.5 的 else 分支：旧记忆 score 减半）。宁可少作废一条，不能让模型幻觉出来的 entity 抹掉用户的医疗约束。

### 口径 3：`constraint` 能不能被作废

**不能自动作废。** 过敏/诊断类记忆（`importance_class = medical`）即使用户说"我不过敏了"，也**只降权不作废**，并在回复里引导用户去 Memory Center 手动删。理由：误作废一条"花生过敏"的代价和误作废一条"最近出差"差着几个数量级，而 LLM 分不清"我不过敏了"和"我这次吃了没过敏"。这条是硬底线，别为了通用性抹平。

### 口径 4：同步还是异步

作废走**同步路径**（`quickExtract`，随本轮请求完成）。理由：用户说"你记错了"之后，**下一句就可能重新问同一个问题**，异步 `fullExtract` 在响应返回后才跑，会导致同一轮对话里 AI 再说一遍错话。代价是同步路径多一次 LLM 往返——可接受，因为 `CONSTRAINT_KEYWORDS` 预筛选已经挡掉了绝大多数消息。

> **⚠️ 两条 prompt 都要改**（`t59-quick-vs-full-extract-prompt` 那条教训）：`QUICK_EXTRACT_PROMPT` 和 `FULL_EXTRACT_PROMPT` 是两份独立文本，改提取规则**两个都得改**，只改一个会出现"异步能作废、同步不能"的诡异不一致。

## 设计要点

> **定位方式**：文中行号是写作时快照，一律用给出的特征字符串搜索定位。

### A. 提取 schema + 两份 prompt（`src/services/memory-extract.ts`）

1. `ExtractResultSchema` 加 `invalidations`（形状见口径 1）。
2. **两份 prompt 都加**一节「## 作废已有记忆」：
   - 触发信号：用户否认已有记忆（"我排便正常了"、"你是不是记错了"、"早就好了"、"我没有不吃X"）、或声明状态已结束（"出差回来了"、"备赛结束了"）
   - `entity` **必须从下方【已有记忆】列表里挑**，列表里没有的一律不输出（防幻觉）
   - `medical` 类记忆不要输出到 `invalidations`（口径 3）
   - few-shot 用背景表里的真实原话：「我排便正常了，你是不是记错了」→ 作废 `recent_constipation`；「我每天都有30分钟的羽毛球」→ 作废 `no_aerobic_exercise` **且**新建 `daily_badminton_30min` habit（**同一句话可以既作废又创建**，这个 few-shot 一定要有，否则模型会二选一）
3. **`quickExtract` 现在不喂已有记忆**（只有 `fullExtract` 喂）——作废必须知道有哪些记忆可作废，所以 `quickExtract` 也要调 `loadActiveMemories(userId)` 并把摘要拼进 prompt。注意这会给同步路径加一次 DB 查询，可接受。
4. 顺手把被丢弃的 `candidate.action` 接上（或者确认走 upsert 键改造后它已冗余，冗余就**从 schema 里删掉**，别留着一个永远没人读的字段——铁律 12）。

### B. `invalidateMemory()`（`src/services/memory-store.ts`）

新增函数，按口径 2/3 实现：

```ts
export async function invalidateMemory(
  userId: string,
  type: MemoryType,
  entity: string,
  opts: { reason: string; llmConfidence: number },
): Promise<"invalidated" | "demoted" | "not_found">
```

- 找 `state IN ('ACTIVE','WEAK')` 且 `type`+`entity` 匹配的**全部**行（含 content 的冲突键意味着可能有多行）
- `importance_class = 'medical'` → 只降权（`llm_confidence` 折半后重算 state），返回 `"demoted"`
- `llmConfidence < 0.80` → 同上，`"demoted"`
- 否则 → `valid_to = now()`, `state = 'ARCHIVED'`, `source_text` 追加 reason，返回 `"invalidated"`
- 找不到 → `"not_found"`（模型幻觉，静默）

现有 `archiveMemory(memoryId)` 是按 id 的手工 API 路径，**不要改它的签名**（`routes/memory.ts` 在用），新函数并列。

### C. upsert 冲突键改造（`prisma/schema.prisma` + `memory-store.ts`）

把 `@@unique([user_id, type, entity, content])` 改成 `@@unique([user_id, type, entity])`，`upsertMemory` 的 `ON CONFLICT` 同步改。这样：

- 「最近3天排便不畅」→「排便已恢复」同 entity 走 `DO UPDATE`，`content` 被覆盖、`repetition_count += 1`，**旧措辞不再留在库里和新的打架**
- 和 `MEMORY_SPEC §5.5`「entity+type 命中已有记忆」的前提对齐
- **数据迁移**：现有库里同 `(user_id,type,entity)` 有多行的，保留 `updated_at` 最新的一条、其余 `state='ARCHIVED'` + `valid_to=now()`。写进 migration SQL，不要写成一次性脚本（这是 schema 变更的一部分）。

> **`ON CONFLICT DO UPDATE` 里的 `state = ${initState}` 有个附带 bug**：`initState` 是用 `repetition_count: 1` **硬编码**算出来的，所以第 5 次重复提及时算出来的 state 仍然按"首次"算，`rep_boost` 的强化在写入时永远不生效（只有凌晨 3 点的 cron 用真实 `repetition_count` 重算时才补回来）。本任务改这一行**顺手修掉**：`DO UPDATE` 分支应该用 `"UserMemory".repetition_count + 1` 重算 state。这是 T75 阈值标定的前提——**别把标定问题和这个算错的输入混在一起调参**。

### D. 接线（`memory-extract.ts` 的 `quickExtract` / `fullExtract`）

两处都在写 `candidates` **之前**先处理 `invalidations`（先作废后创建，避免同一句话里"作废旧的 + 新建同 entity 的"因为顺序反了被自己刚建的行挡住）。作废失败**静默吞掉**，和现有 `upsert failed` 一样只 `console.warn`——记忆是增强不是主流程。

### E. §5.5 的 `opposite` 分派要不要一起做

**本任务只做显式作废通道，不做 §5.5 Step 1 的语义比较 LLM 调用。** 理由：冲突键改成 `(user_id,type,entity)` 之后，"同 entity 语义相反"这个 case 本身就被 `DO UPDATE` 覆盖成"新 content 替换旧 content"了，再加一次 LLM 语义比较是**往调用链里加不是往外减**（和 T63 否掉 Router+Specialist 的理由一致）。§5.5 的 Step 1/Step 2 在 `MEMORY_SPEC` 里保留为设计记录，但**要在 §5.5 下加一段实现注记**说明实际走的是"显式 invalidations 通道 + entity 级 upsert"，别让规范和代码继续对不上——这正是本任务立项的根本原因。

### F. 清理今晚这三条脏记忆

`diarrhea`「用户当前处于拉肚子状态」是**确认为假**的（用户原话"已经一周了，早就好了"）。功能做完之后，用真实对话回放验证它会被作废；如果回放不触发，手动经 Memory Center API 删掉，**并把这个 case 写进回归用例**——一条已知为假却删不掉的记忆留在生产库里，等于给后面每一次真机验证埋了噪声。

## 验收

**必须真机验证。** 起干净端口：`PORT=9309 npm run dev`。

1. 库里存在 `context_state/recent_constipation` ACTIVE → 说「我排便正常了，你是不是记错了」→ 该行 `state='ARCHIVED'` 且 `valid_to` 非空
2. 同上，说「我每天都有30分钟的羽毛球」→ `no_aerobic_exercise` 被作废 **且** `daily_badminton_30min` 被创建（**一句话两件事，同一轮内完成**）
3. 作废后**同一轮对话里**再问"我肚子怎么还这么大" → AI 回复**不再提排便**（口径 4 的同步路径就是为了这条）
4. 说「我不过敏了」→ `constraint/peanut` **不被作废**，只降权；`state` 仍非 ARCHIVED
5. 模型幻觉出一个库里没有的 entity → `invalidateMemory` 返回 `not_found`，不报错、不误伤别的行
6. upsert 键改造后：同 entity 连说两次不同措辞 → 库里**只有一行**，`repetition_count=2`，`content` 是最新那句
7. `repetition_count=3` 的记忆写入时 state **按 rep=3 算**（不再硬编码 1）
8. 迁移脚本在真实库上跑通，现有同 entity 多行的被正确合并（**先 `pg_dump` 备份**）
9. `npm run eval` 不退化（记忆注入会改变 chat 上下文，必须回归）
10. `MEMORY_SPEC.md` §5.5 加实现注记、§11 已知盲区更新（"记忆只进不出"从盲区里划掉）

## 提示词

```
做 docs/tasks/T74-memory-invalidation.md。

先读 CLAUDE.md 铁律和 docs/MEMORY_SPEC.md §5.5/§6，再读任务文件全文。
四条"必须先定的口径"已经拍板了，按上面写的做，不要重新设计。

三个最容易翻车的点：
1. QUICK_EXTRACT_PROMPT 和 FULL_EXTRACT_PROMPT 是两份独立文本，两个都要改；
2. quickExtract 当前不喂"已有记忆"，作废功能要求它必须喂；
3. 改 @@unique 要写数据迁移合并现有多行，跑之前先 pg_dump 备份。

constraint/medical 不许自动作废——这是硬底线，别为了通用性抹平。

做完按验收清单逐条真机验证：PORT=9309 npm run dev。别动 :9300。
验收通过后把状态改成 ✅ 于两处：本文件顶部 + docs/TASKS.md 该行（含顶部进度计数）。
```
