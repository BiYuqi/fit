# T73 — 运动记录改时长：协议缺失 + 更新不完整（对话精度 R2）

**状态**：✅完成（2026-07-28）　　**优先级：本轨最高**（既让用户走进死循环，又已经写出自相矛盾的脏数据）

**目标**：用户说「今天羽毛球是15分钟」时，系统当前**没有任何字段能承载这个指令**，只会反复追问"请告诉我新的消耗热量是多少"。这是 T64 的同一种病：协议里没有的字段，模型无处安放。同时修掉运动 update 只写一半字段导致的 `duration_min` / `calories_burned` 互相矛盾。

**依赖**：无。
**关注文档**：`AI_PARSING_SPEC.md` §8（modify 协议，需新增字段定义）、`DATA_MODEL.md`（`exercise_record` 字段语义）、`API_SPEC.md`（`POST /api/records/:id/undo` 的 `prev_state` 形状要扩）。

## 背景（2026-07-27 真机，账号 outoftoken，用户连骂三句后立项）

```
21:58 用户: 我每天都有30分钟的羽毛球
     系统: [exercise_card] 羽毛球 30分钟 消耗约 195 kcal

21:59 用户: 今天羽毛球是15分钟
     系统: 请告诉我新的消耗热量是多少？比如「改成 400 千卡」。

21:59 用户: 15分钟不会算？
     系统: 请告诉我新的消耗热量是多少？比如「改成 400 千卡」。   ← 一字不差，第二遍

21:59 用户: 你神经病吧
22:00 用户: 改
22:00 用户: 记录为啥没改？
22:00 用户: 我日！
22:01 用户: 我就不说，你就直接改会死吗
     系统: [exercise_card] 已更新：羽毛球 消耗 98 kcal（原估算 195 kcal）
```

### 更前一层的根因（2026-07-28 用户指出，立项时漏了）

**`我每天都有30分钟的羽毛球` 压根不该入库。** 这是频率性习惯陈述——属于用户画像（记忆系统的 `habit` 类型，`memory-extract.ts` 的触发词里本来就有"每天"），不是"今天做了"这一次的事实。凭一句习惯替用户记一笔他今天未必做过的账，当天数据凭空多出 195 kcal。

而 `今天羽毛球是15分钟` 带明确日期词 + 具体时长，**是今天的实际运动，应该入库**。

两句合起来看，正确行为是：第一句判 `chat`（记忆侧提 habit），第二句判 `record` 建一条 15 分钟的记录。**第一句不入库，第二句就自然是 record 而不是 modify，整个死循环根本不会发生**。所以本任务同时修两层：

- 意图层（新增）：频率词 + 无当次线索 → 不建记录。判据与例外写进 `SYSTEM_PROMPT` 的「关键判断规则」段（见 B'）。
- 协议层（原有）：用户确实要改一条已有运动记录的时长时，modify 得有字段能接住。两层都要修——协议缺字段本身是独立缺陷，不因根因修了就不存在。

**用户是对的，这就是"不会算"**：MET 表和 `calcExerciseCalories()` 就在 `src/services/intents/exercise.ts`，按时长重算是一次函数调用。羽毛球 MET=5、体重 78kg（`user.weight_kg`）→ `5 × 78 × 15/60 = 97.5`，和最后人工算出来的数字**完全一致**。缺的不是算力，是协议字段。

### 已经写出的脏数据

```sql
-- ExerciseRecord e122ddb1（真实生产数据）
type=羽毛球 | duration_min=30 | calories_burned=97.5
```

`modify.ts` 的运动分支只 `update({ calories_burned })`，**没动 `duration_min`**。现在库里躺着一条"30分钟烧了97.5千卡"的记录，卡片 payload 同样是 `{duration_min: 30, calories_burned: 97.5}`——用户看到的卡片自相矛盾。这条不是孤例，是**所有走过运动 update 的记录的必然状态**。

### 隐形失败：早退不结束 trace

那两条追问在 `AiTrace` 里是：

```
21:59:24 | 今天羽毛球是15分钟 | intent=NULL | status=started
21:59:43 | 15分钟不会算？      | intent=NULL | status=started
```

`modify.ts` 里三处早退（"这条运动记录好像已经不在了" / "请告诉我新的消耗热量" / "这条记录好像已经不在了"）**都不调 `tctx.ok()` 也不调 `tctx.fail()`**，trace 永久卡在 `started`。后果：这类失败在 `npm run audit`、eval、任何按 `status` 聚合的统计里**全是不可见的**——T63 立项时说的"把发现路径从『用户骂』换成『跑一遍』"，在这条路径上没有兑现。

## 必须先定的口径（实现前确认，别自己拍）

**用户只给了新时长，热量怎么办？** 三种口径，本任务采用第 2 种：

1. 热量不动 → 就是现在这个 bug 的成因，数据自相矛盾
2. **按 MET 用新时长重算**——原热量本来就是 MET 估的（`user_reported=false`），用户改的是估算的输入，重算是唯一自洽的做法
3. 追问用户新热量 → 就是现在这个死循环

**关键分支**：如果这条记录的热量是**用户自报**的（T50，`exercise_card.payload.user_reported === true`），改时长时**不重算热量**——用户自己报的 590 千卡不该被 MET 估算覆盖掉。此时只改 `duration_min`，回执明说"热量沿用你报的 590"。

> `ExerciseRecord` 表**没有 `user_reported` 字段**（T50 注释："exercise_record 无 calories_source 字段，也不需要"）。本任务需要这个信息来判分支——**加一个 `user_reported Boolean @default(false)` 字段**，`record.ts` 落库时一并写入。这是 T50 当时省掉、现在被 modify 路径要回来的债，别用"从 chat_message payload 反查"这种绕法（聊天记录是展示层，不是事实源——铁律 3）。

**重算用哪个体重？** 用 `user.weight_kg`（初始体重），和 `record.ts:33` 同一个来源。不要顺手改成读 `weight_log` 最新值——那会让"改时长"顺带改变热量基准，用户没授权；口径变更是 `maintain-mode-shelved` 那条挂起的独立议题。

## 设计要点

> **定位方式**：文中行号是写作时快照，一律用给出的特征字符串搜索定位。

### A. Schema（`src/ai/schema.ts`）

`ModifyChangeSchema` 新增：

```ts
duration_min: z.number().positive().optional(), // T73：改运动时长（"羽毛球是15分钟"），后端按 MET 重算热量
```

`changeProp.properties` 同步加：

```ts
duration_min: { type: "number", description: "运动记录的新时长(分钟)，如'羽毛球是15分钟'、'只跑了20分钟'。填这个时不要同时填 calories_burned（除非用户两个都说了）——后端会按 MET 用新时长重算消耗" },
```

`changeProp.description` 里"改运动消耗填 calories_burned"那句就地改写为：**改运动时长填 duration_min（"羽毛球是15分钟"），改运动消耗填 calories_burned（用户用穿戴设备数据纠正）；用户只说时长就只填 duration_min，热量交给后端按 MET 重算，不要自己心算填 calories_burned**（铁律 1：AI 不算账）。

### B. Prompt（`src/services/parser.ts` `SYSTEM_PROMPT`）

> **⚠️ T72 已做过一次全文收口合并去重。别在末尾堆新条款。**

`SYSTEM_PROMPT` 现有这条（约 55 行）：

```
- 改运动消耗（"改成400"、"应该是350卡"），且 target 指向运动记录（ref 以 e 开头）→ change.calories_burned，填用户给出的数字。
```

**就地改写**为同时覆盖两个维度，别新增一条并列条款（新增就是"规则堆叠互相稀释"的老毛病）：时长维度 → `change.duration_min`，热量维度 → `change.calories_burned`，两者都说了就都填。配一条 few-shot，用背景里的真实原话「今天羽毛球是15分钟」。

同时确认 `SYSTEM_PROMPT` 里没有别的条款和这条打架（尤其 T65 加的显式指令优先级、T50 的 record 侧 `calories_burned` 采信规则——那条讲的是 record 不是 modify，别混）。

### B'. 习惯陈述不建记录（同文件「关键判断规则」段）

在 `- 只有用户明确表示要记录新的食物/运动时才用 record。` 之后补一条：频率词（每天/天天/每周/一般/通常/总是/都会/习惯）且无当次线索 → 判 `chat`，不建记录；带日期词/当次线索（"今天…"、"刚打完"、"昨天打了1小时"）照常 `record`。**要明说"今天/昨天"这类日期词就是当次线索**，否则模型会因为句子里同时有"羽毛球"和数字而倾向沿用上一条的习惯判定。规则放 record 段而不是 chat 段——这是在收窄 record 的边界。

### C. 运动 update 分支重写（`src/services/intents/modify.ts`，搜 `if (target.kind === "exercise")`）

现有逻辑：`if (!change.calories_burned) → 追问` 然后 `update({ calories_burned })`。**整段重写**：

1. 取 `duration_min` 和 `calories_burned` 两个入参，**两个都没有才追问**；追问文案改成同时提两种说法（"改成15分钟"或"改成400千卡"）。
2. 算新值：
   - 给了 `calories_burned` → 直接采信（用户真值），`user_reported = true`
   - 只给了 `duration_min`：
     - 原记录 `user_reported === true` → 热量不动，只改时长
     - 否则 → `calcExerciseCalories(exRec.type, newDuration, weight_kg)` 重算
3. `prisma.exerciseRecord.update()` **把变了的字段全写进去**（时长和热量），不要只写一半。
4. `prev_state` 补 `duration_min` 和 `user_reported`，否则撤销回不到原状态（见 E）。
5. 回执文案带上时长：`已更新：羽毛球 15分钟 · 消耗约 98 kcal（原 30分钟 · 195 kcal）`。热量沿用用户自报时说明白，别让用户以为系统没重算。
6. `exercise_card` payload 的 `duration_min` 用新值。

### D. 三处早退补 trace 结束（同文件）

`modify.ts` 里这三处 `return` 之前补上 `tctx.ok("modify", { tokenUsage: parseUsage, promptMessages: parseMessages })`：

- `"这条运动记录好像已经不在了。"`
- 运动追问分支（重写后仍会保留追问，只是文案变了）
- `"这条记录好像已经不在了。"`

追问是**正常的澄清轮次不是错误**，用 `ok` 不用 `fail`；判据是"意图识别成功、只是信息不全"。顺手扫一遍 `src/services/intents/` 下其他文件有没有同类早退漏掉 `tctx.ok/fail`——这是本任务真正的长期价值（让失败可见）。

### E. 撤销链路补 duration_min（`src/routes/records.ts` + `src/routes/chat-history.ts`）

- `records.ts` 的 `prev_state` zod schema（搜 `calories_burned: z.number().positive()`）加 `duration_min: z.number().positive().optional()` 和 `user_reported: z.boolean().optional()`。
- `records.ts` 的 update 撤销分支（搜 `// update 撤销 → 还原消耗热量`）从只还原 `calories_burned` 改成还原全部快照字段。
- `chat-history.ts` 的 exercise 重建分支（搜 `if (prevState.kind === "exercise")`）确认 `duration_min` 已在快照里传下去了（当前是走 `DeleteSnapshot`，形状可能已包含，**确认而非盲改**）。
- `API_SPEC.md` 里 `prev_state` 的字段表同步更新。

### F. 修历史脏数据

写一个一次性脚本（参照 `scripts/t70-cleanup-dirty-food-variants.ts` 的写法）扫出所有 `ExerciseRecord` 里 `calories_burned` 与 `MET × weight × duration/60` 偏差超过 20% 且 `user_reported=false` 的记录。**不要自动改**——先打印出来人工看，生产数据只有 outoftoken 一个真人，规模可控。上面那条 e122ddb1 按 15 分钟修正（用户的真实意图是 15 分钟）。

### G. 附带修复：不要承诺不存在的流程（`src/ai/answers.ts`）

同一晚 17:19：

```
用户: 我的聊天记录为啥没了
系统: 刚才可能是出了点状况，聊天记录没加载出来。这个情况我记下了，会反馈给开发团队排查。
```

**没有开发团队，也没有任何反馈流程**——这句是凭空承诺。根因是 `answers.ts` 报障话术那段里的「说明这个反馈会被记录关注」，模型把它演绎成了具体的工单流程。

把这条改写成：承认现象 + **明确不承诺任何不存在的后续动作**（不说"会反馈"、"已记录"、"工程师在看"）+ 引导用户继续当前操作。这和同段已有的「不编造具体故障原因」是同一条原则的两面——**别编造原因，也别编造流程**，一起写在一条里。

> 顺带澄清事实：聊天记录并没有丢。`/api/chat/messages?date=` 是**按天取**的，用户 07-15 之后到 07-27 没用过 App，打开就是空的——这是设计如此（`ARCHITECTURE.md` 聊天保留策略），不属于本任务的修复范围，**别顺手去改成跨天加载**（铁律 10）。

## 验收

**必须真机验证，别只跑单测**（`t59-quick-vs-full-extract-prompt` 那条教训：同步/异步两条 prompt 路径改了一个漏一个）。起干净端口：`PORT=9309 npm run dev`，`EVAL_API_BASE=http://localhost:9309 npm run eval`。

0. 「我每天都有30分钟的羽毛球」→ 判 `chat`，**不建 `ExerciseRecord`**（记忆侧照常提 habit）
1. 「打了30分钟羽毛球」→ 卡片 30min / 约195kcal（体重78kg 基准）
2. 「今天羽毛球是15分钟」→ 今日无同名记录时判 `record` 建一条 15min；已有同名记录时判 `modify` **一轮直接改掉**，卡片显示 15min / 约98kcal，**不再追问热量**
3. `ExerciseRecord` 该行 `duration_min=15 AND calories_burned=98`，两个字段一致
4. 「羽毛球改成400千卡」→ 只改热量，时长不动，回执不谎称重算
5. 「打球65分钟消耗590卡」（T50 自报路径）→ 再说「其实只打了40分钟」→ **热量仍是590**，只有时长变，回执说明热量沿用自报值
6. 撤销 2 和 4 的卡片 → 时长和热量**都**回到原值
7. `AiTrace` 里上述每一轮 `status` 都是 `ok`（含追问轮），**没有 `started` 残留**
8. `npm run eval` 不退化；`npm run audit` 跑一遍确认运动修改类信号采纳率上去了
9. 改 prompt 前后都跑 eval（`conversation-intelligence-track` 铁律）

## 落地记录（2026-07-28）

实现与本文设计的差异，以及验收实测：

- **提示词治不住意图误判，加了确定性纠偏**（`routes/chat.ts`）。B' 那条规则写进 `SYSTEM_PROMPT` 后，「今天羽毛球是15分钟」在今日无记录时仍有约一半概率被判 modify（实测 1/2）。改用可证伪的事实触发重解析：**判了 modify 但 target 引用的 ref 在 `pack.recent_records` 里一个都不存在** → 这条 modify 无论如何执行不了（原本只会回一句"没找到要修改的那条记录"，用户说的话就白说了），用 pro 带一次性纠偏提示重解析，只在 record / chat 间二选一。`parseUserInput` 为此加了 `retryHint` 参数——**这是给"确定性前提被证伪"用的，不是"提示词不灵就再补一句"的口子**。第一版纠偏提示把 chat 写成了并列选项，模型改走 chat（同样丢数据），收紧成"有食物/运动+数量或时长就必须 record，只有纯提问才 chat"后连过 7 次。
- **eval harness 补了 `exercise_record_count`**（`eval/run.ts`），与 `food_record_count` 对称。要断言"习惯陈述不入库"必须能数行，只断言字段无法区分"没记"和"记错"。
- **`user_reported` 存量回填**：迁移把所有历史行填成 `false`，其中"记录时用户就自报了热量"的老记录会被误判成脏数据。按 `raw_input ~ '[0-9]+ *(卡|大卡|千卡|kcal)'` 回填 47 行为 `true`。`scripts/t73-audit-exercise-mismatch.ts` 里写明了这个判读陷阱。
- **脏数据**：扫描 98 条 MET 估算记录，46 条矛盾，其中 45 条是 eval 账号的 T50 用例（自报值，回填后消失）。真人只有 e122ddb1 一条，已按用户真实意图修成 `duration_min=15 / calories_burned=98` 并 recompute 07-27。
- **prisma migrate dev 用不了**：库里有 T54 遗留的 hnsw 索引 drift（`UserMemory_embedding_idx` 在库里但 schema 未声明），`migrate dev` 要求 reset 全库。改为手写 `migration.sql` + psql 执行 + `migrate resolve --applied`。**这个 drift 是既有的，别去"顺手修"它**。
- **audit 无运动信号**：验收第 8 条说的"audit 确认运动修改类信号采纳率上去了"做不到——`scripts/audit.ts` 只统计食物侧，压根没有运动修改这一类。已跑但不构成本任务的证据。
- **eval 全量**：4 条红，逐条复跑确认 3 条是抖动——`food-desc-no-double-suffix`（模型偶尔把 food_desc 填成"无油版"）、`meal-batch`（记忆里本就有记录的老抖动）、`quantifier-delete`/`pending-text-answer`（记录建了，只是匹配到"水煮蛋"/"刀削面"而非断言的"鸡蛋"/"熟面条"）。单跑均通过。
- **顺带发现（未处理）**：T70 的后缀去重只认字面相同，`葱花饼（无油）（无油版）` 仍会叠加。audit 已把它列进可疑清单，属 T70 的覆盖缺口，不在本任务范围。

## 提示词

```
做 docs/tasks/T73-exercise-duration-modify.md。

先读 CLAUDE.md 铁律，再读任务文件全文，特别注意"必须先定的口径"一节——
user_reported 字段要加进 ExerciseRecord 表（含 prisma migrate），别用反查 chat_message 绕过去。

改 SYSTEM_PROMPT 时就地改写现有那条运动修改规则，不要新增并列条款（T72 刚做过收口）。

做完按验收清单逐条真机验证：PORT=9309 npm run dev 起干净服务，
EVAL_API_BASE=http://localhost:9309 npm run eval。别动 :9300。

验收通过后把状态改成 ✅ 于两处：本文件顶部 + docs/TASKS.md 该行（含顶部进度计数）。
```
