# T51 — 聊天记录实测体重 + 收敛 weight_log 采集口径

**状态**：✅完成

**目标**：让用户在聊天里口头上报实测体重（"今天体重77.75公斤"）能**真正落库**——只 append `weight_log` 历史点，**绝不改档案初始体重 `user.weight_kg` / 目标体重**。同时收敛 `weight_log` 的采集口径，去掉一条会污染地面真值的脏路径。

**依赖**：无强依赖。复用 `upsertWeightLog`（`services/learning.ts`，LEARNING_SPEC §8）与既有意图路由框架（`chat.ts` + `ai/schema.ts` + `parser.ts`）。
**关注文档**：`AI_PARSING_SPEC.md` §2/§13、`DATA_MODEL.md`（weight_log）、`LEARNING_SPEC.md` §8、`API_SPEC.md`（PUT /user/profile、chat 响应 intent）

## 背景（2026-07-05 真实死循环，账号 outoftoken）

用户最新 8 条聊天里反复说"现在体重到了77.75了""今天体重77.75公斤"，AI 每次都回"我来帮你存上""直接说『记录今天体重X』就行"，但 `weight_log` 表**始终 0 行**，用户陷入死循环、明确点破"咱们不是有实时记录体重的逻辑吗，不用改我的初始体重，你只是负责记录"。

排查确认：**聊天侧根本没有写体重的路径**。意图枚举只有 record/query/chat/modify/discuss/resolve_pending，体重话全被路由成 `chat` → 进 `answers.ts` 自由聊天 → 只产文本、物理上碰不到 `weight_log`。唯一写库处是 `routes/user.ts` 的 `PUT /user/profile`（改档案体重时顺手 append）。AI 承诺"我来帮你存"是**纯幻觉**。

## 设计要点

### A. 新意图 record_weight（聊天写实测点）
- **schema**（`ai/schema.ts`）：`IntentSchema` + `ParseResultSchema` 加 `record_weight` 变体（`weight_kg: number 20~500`）；tool schema enum + `weight_kg` 属性，让 DeepSeek 能选。
- **parser 提示词**（`services/parser.ts`）：加意图行 + 规则块——"今天体重X/称了X斤"→记录（斤÷2）；**边界**：询问体重（"我现在多少斤"）是 query/chat、食物克数（"150克米饭"）是 record、目标体重设定不是 record_weight；报体重又同时报吃/动时优先 record（ops 只收 record/modify）。
- **handler**（`services/intents/record-weight.ts`，新建）：**awaited** upsert `weight_log`（同一天覆盖当天行），**绝不动 `user.weight_kg`**。与设置页那条 `upsertWeightLog`（fire-and-forget、静默失败）不同——这里是用户显式指令，写入失败要抛（`chat.ts` catch 转诚实报错），绝不"说存了其实没存"。回执确认已记 + 相对上次实测点/初始体重的增减趋势。
- **路由**（`routes/chat.ts`）：dispatch record_weight。

### B. 最新实测点注入上下文
- `services/memory.ts`：记忆包 `profile.latest_weight_kg/date`（查最近一个 `weight_log` 点）。
- `ai/ctx.ts`：【用户档案】渲染成"初始体重X 最新实测体重Y(日期)"。AI 答"现在体重多少"引实测值，不再说"当前记录里还是78kg"这种过时话。

### C. 收敛 weight_log 采集口径（去脏路径）
讨论口径（本任务附带的设计决定）：
- **初始体重 `user.weight_kg` = BMR/TDEE 计算基准**；**`weight_log` = 实测趋势/§8 地面真值**。两者概念分离。
- `weight_log` 三条来源里，**「重看引导」提交是脏路径**——重看的本意是回看/调目标，不是称重，若顺手动了体重就会污染 §8 校准。**摘掉它**。
- **首次引导**（留起点锚）与**设置页改体重**（多为真称重）**保留** append，作兜底采集（现阶段 record_weight 刚上线、用户习惯未养成，砍采集会让 §8 无数据；§8 自带护栏——两点间隔 ≥2~3 周、变化小于水分噪声则跳过——能滤部分噪声）。
- **落地**：`PUT /user/profile` body 加控制位 `is_review?:bool`（非档案列，落库前 destructure 剔除）；前端 `onboarding-screen.tsx` 在有 `initialData`（=从设置页重看进来）时置 `is_review:true`；后端 `!is_review` 才 append。

## 验收

- 聊天"现在体重到了77.75了" → `intent=record_weight`，`weight_log` 最新点=77.75，`user.weight_kg` 纹丝不动，回执含 77.75。✅
- "今天体重77.6公斤""早上称了154斤"（斤→77）同上；同一天覆盖当天行。✅
- "我现在体重多少"→ query/chat，不写库、不误判 record_weight。✅
- "中午吃了150克米饭"→ record 食物，不误判 record_weight。✅
- 重看引导走完提交、即便改了体重 → 不 append `weight_log`（`is_review=true`）；首次引导 + 设置页改体重照常 append（回归红线）。
- 单测：ctx 渲染区分初始/最新实测体重；tsc 干净。

## 落地记录（2026-07-05 完成）

改动：
- `ai/schema.ts`：record_weight 意图 + weight_kg（zod + tool schema）。
- `services/parser.ts`：意图行 + record_weight 规则块（斤换算、询问/食物克数/目标体重边界）。
- `services/intents/record-weight.ts`（新建）：awaited upsert weight_log + 趋势回执，不碰档案。
- `routes/chat.ts`：dispatch record_weight。
- `services/memory.ts` + `ai/ctx.ts`：latest_weight_kg/date 注入【用户档案】。
- `routes/user.ts`：PutBodySchema 加 `is_review`；destructure 剔除；`!is_review` 才 append。
- `frontend/src/components/onboarding-screen.tsx`：重看（有 initialData）提交带 `is_review:true`。
- `eval/run.ts`：新增 `weight_log` / `user` 两个 db 断言；`eval/cases/weight-log.yaml` 新用例。
- docs：AI_PARSING_SPEC §13、DATA_MODEL weight_log、LEARNING_SPEC §8、API_SPEC 全同步。

验证：
- 后端单测 132 全过（含新增 ctx 渲染测试：区分初始/最新实测体重）；前后端 tsc 均 0 错。
- eval `weight-log` 用例 5/5 通过（直报 / "公斤" / 斤换算 / 询问判 query 不误记 / 食物克数不误记；每轮断言 weight_log 写入 + user.weight_kg 不变）。
- 全量 eval 唯一红灯 `quantifier-delete` 系 DeepSeek flash 边界抖动（"2个鸡蛋"偶发不记录），单跑复测全绿，与本任务无关。

**未做（留待日后）**：Today/设置页专门的"记体重"快捷入口——有了它可把设置页那条 append 也收干净，彻底走"基准/实测"分离。食物侧"报热量"协议缺口同理留待单独立项（见 T50 尾注）。
