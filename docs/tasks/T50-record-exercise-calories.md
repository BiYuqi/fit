# T50 — record 阶段采信用户直报运动消耗

**状态**：✅完成

**目标**：用户在**记录运动的同一句话里**直接给出消耗数字时（"打羽毛球65分钟，消耗590卡"），后端直接采信该数字入库，不再强制走"先按 MET 估算落库 → 用户发现偏差大 → 再发一句『改成X卡』覆盖"的两步流程。

**依赖**：无强依赖。复用已有 exercise `modify.update` 的 `calories_burned` 覆盖先例（`backend/src/services/intents/modify.ts:193-224`）。
**关注文档**：`AI_PARSING_SPEC.md` §3（record 协议）、`DATA_MODEL.md`（exercise_record）

## 背景（2026-07-04 真实案例）

用户消息："打羽毛球65分钟，消耗590卡" → 系统按 MET 公式算成 422kcal 落库，用户给的 590 被结构化解析直接丢弃。用户追问"为什么不录入我说的消耗"，得到"要改的话请说『改成590卡』"——用户照做后，第二条消息才把 590 写进去。

排查后确认这不是刻意的质量闸门：

- **modify 阶段（"改成590卡"）对用户数字来者不拒**——系统不区分这个数字是用户看了手表读出来的还是随口估的，没有任何验真机制。
- **record 阶段拒绝，仅仅是协议历史遗留**：`calories_burned` 覆盖机制设计时只考虑"改一条已存在的记录"，从没设计过"record 一句话当场给出消耗值"。`exerciseProp`（`backend/src/ai/schema.ts:230-244`）里根本没有热量字段，`additionalProperties: false` 硬性堵死，AI 想输出也没地方写。

结论：**现在的"两步"没拦住任何不可信数据，只是让用户多打一句话。** modify 阶段既然已经信任用户报的数字，record 阶段没有理由不信。

## 立场（铁律辨析）

铁律1禁的是 **AI 算账**，不禁**用户报数**。用户在 record 消息里明确给出的消耗数字是用户真值，后端原样落库；AI 不做任何数值计算，只是抄写用户已经给定的数字。

## 范围：只做运动

食物侧同样存在这个协议缺口，但**不在本任务范围**：现实里用户几乎不知道一盘菜多少卡，"食物报热量"极罕见；且食物路径远比运动重（给了总热量仍要跑完整套估份量流程拿宏量素比例再缩放，不是"抄写"）。运动是真需求（手表直接给消耗）且改动干净，先单独做。食物留待日后单独立项。

## 设计要点

- **schema**：`ExerciseItemSchema` / `exerciseProp` 新增可选字段 `calories_burned`（record 用户自报消耗）。multi（T45）的 record 变体复用同一 sub-schema，一处改动自动覆盖单条与 multi 两条路径。
- **落库**：建 `exercise_record` 时若 `calories_burned` 有值，直接采信写入，跳过 MET 公式；无值则维持现状按 MET 估。
- **无需 source 标记**：`exercise_record` 没有 `calories_source` 字段，也不需要——它从不被后台重算（daily_summary 只是把它加总），用户值一旦写入就安全，只有显式 modify 才会改。这跟食物侧必须打 `user_override` 保护不同。
- **parser 提示词**：补一条规则，让模型识别"消耗X卡/烧了X大卡"是用户自报消耗值，与"打了65分钟/做了30个"这类时长/次数表达分开填。
- **采信门槛**：只要句子里有明确的消耗卡数就采信，不区分语气笃定与否（"大概590卡"也信）。
- **卡片显示**（小开放点）：运动卡当前无"估"角标，若要区分"用户自报 vs MET 估"再定是否加标记；不加也可，不阻塞主逻辑。

## 验收（草拟）

- "打羽毛球65分钟，消耗590卡"（一条消息）→ 直接入库 `exercise_record.calories_burned=590`，不再需要"改成590卡"第二句。
- 常规无消耗数字的 record（"跑步30分钟"、"打羽毛球65分钟"）→ 行为不变，仍按 MET 计算（回归红线）。
- "消耗大概590卡" → 同样采信 590（门槛不看语气）。
- 单测：`calories_burned` 在 record 变体（含 multi op）的 zod 校验；有值走采信、无值走 MET 的分支。

## 落地记录（2026-07-04 完成）

改动：
- `schema.ts`：`ExerciseItemSchema` + `exerciseProp` 加可选 `calories_burned`。multi 的 record 变体复用同一 sub-schema，单条与 multi 一处覆盖。
- `exercise.ts`：新增纯函数 `resolveExerciseCalories`——有自报值直接采信（`user_reported:true`），否则回落 `calcExerciseCalories`(MET)。
- `record.ts`：运动落库改用 `resolveExerciseCalories`；自报值回复不加"约"，payload 带 `user_reported`（前端可选用）。
- `parser.ts`：运动记录规则加一条——"消耗X卡/烧了X大卡"填 `calories_burned`，与时长/次数数字区分。
- `eval/run.ts`：断言层新增 `exercise_record` 支持（纯运动消息 reply 恒为"已记录。"，只能从落库层断言）。
- 新增 `eval/cases/exercise-user-calories.yaml`。

验证：
- 单测 131 全过（含 `resolveExerciseCalories` 4 条：采信/四舍五入/MET 兜底/0 边界），tsc 干净。
- eval 用例 `exercise-user-calories` 连跑稳定通过（核心 turn "打羽毛球65分钟，消耗590卡" → 65 归 duration、590 归 calories_burned 采信，7/7 通过）。
- 全量 eval 的 `meal-batch` / `quantifier-delete` 红灯经基线对比（stash 后同样红/时红时绿）确认为 DeepSeek 边界抖动，与本任务无关。

**卡片"估/自报"标记**：payload 已带 `user_reported`，但运动卡当前本就无"估"角标，前端未加视觉区分，留作后续可选。
