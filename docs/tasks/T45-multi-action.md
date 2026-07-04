# T45 — 复合动作 multi：一条消息多个独立动作按序执行（对话智能 C）

**状态**：✅完成（2026-07-04）

**验收记录**：后端单测 117/117（新增 3 个：批量 target 单/数组形态、multi 两 op 解析+T42 归一化在 op 内生效、multi 拒绝非法 ops）；`tsc` 零错误；新 eval 用例 `multi-action` 3 轮全绿（真实翻车对话原话回放：删除出确认卡 + 葱花饼 30g 早餐入库 + "无油"未污染粽子 + 确认后粽子消失）；全量 `npm run eval` 7 用例 42 轮 0 新回归（flash 一次判对 multi，未升 pro）。

**目标**：让"把刚才吃的粽子删除了，我记得早晨还吃了30克葱花饼，无油的"这类**一句多事**的消息不再丢动作、不再互相污染。解析协议新增 `multi` 意图：ops 数组按用户叙述顺序装 2~4 个 record/modify 动作，后端顺序循环调用现有单意图 handler，卡片与回复逐个累积。

**依赖**：T41（回归评测集）
**关注文档**：AI_PARSING_SPEC §12（协议唯一定义处，本任务新增）、§2 意图路由（加 multi）、§8（顺带：批量改餐次 target 数组，同日修复）

## 背景（为什么会有这个任务）

2026-07-04 真实使用翻车：用户一条消息包含两个动作——①删除粽子记录 ②补记 30 克无油葱花饼（早餐）。单意图协议装不下，模型被迫缝合成一个 modify：
```json
{"intent":"modify","action":"update","target":"r7","change":{"food_desc":"无油","meal_type":"breakfast"}}
```
结果三输：删除丢失、葱花饼没记、**"无油"安到了粽子头上**（触发 T40 属性修正重估，粽子→"粽子（无油）"）。复合消息是自然表达（用户原话就是最顺的说法），必然高频，判定为协议层能力缺失而非 prompt 问题，立项走方案 1（多动作协议），不做"引导用户分开说"的止血方案。

## 设计要点

- **ops 只允许 record / modify**（2~4 个）：真实复合场景都是动作组合；query/chat/discuss 不进 ops（夹闲聊忽略闲聊，夹查询只执行动作）。"吃了A和B"是一个 record 的多 items，不是 multi。
- **每个 op 带 `raw` 原文子句**（照抄）：后端把 raw 当该 op 的 text 用——餐次关键词提取（`extractMealTypeFromText`）、pending 的 raw_input、估算上下文都按子句走。这是防修饰词污染的机制保证，不只靠模型自觉。
- **refs 按消息开始时的 L1 快照解析**，op 之间不重建记忆包（modify 的 target 都指向已有记录，record 不用 ref，无依赖）。
- **破坏性分级不变**：ops 里的 delete 照常出确认卡，update/record 照常高置信直入库+撤销、低置信出卡。
- **trace**：各 op handler 内部照常 finalize（last-write-wins），multi 分发完成后统一收口 `tctx.ok("multi")`。
- **防御归一化**（parser，与 record 空壳降级同段）：空壳 op 剔除；只剩 1 个拍平成对应单意图；全无降级 chat——硬拒会触发 pro 重试链，双模型都错时整条消息兜底 chat 丢全部动作，比拍平更糟。
- **L0 记忆兼容**：memory.ts 对 intent=multi 拍平所有 record op 的 items 作指代锚点（否则复合消息里刚记的食物下一轮"再来一份"找不到）。

## 改动清单

- `backend/src/ai/schema.ts`：record/modify 变体抽成具名 schema（`RecordVariantSchema`/`ModifyVariantSchema`，加 `raw` 字段）供 multi 复用；`MultiOpSchema` + multi 变体；tool schema 共享属性抽常量（`actionProp` 等），顶层与 `opSchema` 引用同一份。
- `backend/src/services/parser.ts`：提示词 multi 段（含真实翻车例、修饰词归属规则、不过度触发护栏）；防御段 ops 清洗。
- `backend/src/routes/chat.ts`：multi 分发循环（op.raw 替换 ctx.text）。
- `backend/src/services/memory.ts`：L0 拍平 multi 的 record items。
- `frontend/src/types/chat.ts`：intent 联合类型加 `'multi'`。
- `backend/eval/cases/multi-action.yaml`：真实翻车对话回放。
- `docs/AI_PARSING_SPEC.md`：§2 路由 + 新增 §12。

## 验收

1. 单测：`npm test` 全绿（multi schema 解析/拒绝/归一化）。
2. eval：`npm run eval -- --case multi-action` 全绿——删除确认卡 + 新食物入库 + 修饰词不串台 + resolve 后删除生效。
3. 全量 `npm run eval` 无新回归（重点：单动作消息不被误判 multi——zhidai/pending-text-answer/chunhuabing 全是单动作用例）。
