# T42 — chosen_label 护栏：用户明示克数被静默改档（数据污染级）

**状态**：✅完成（2026-07-03）

**目标**：parser 返回的 `chosen_label` 在 `portions` 里找不到对应条目时，不再静默回退小份；用户明说的克数必须原样入库。
**依赖**：无　**关注文档**：AI_PARSING_SPEC §3、eval/cases/chunhuabing.yaml（第 1 轮）

## 背景（T41 回放器抓获，2026-07-03）

用例输入"晚上吃了100克葱花饼 煎的"。DeepSeek 部分响应形态为：`portions=[小80/中120/大160]` + `chosen_label="custom"`——**没有 custom 条目**。`food-item.ts` 中：

```ts
const rawChosen = portions.find((p) => p.label === chosen_label) ?? portions[0];
```

fallback 命中 `portions[0]`（小份 80g）→ 用户明示的 100g 被静默记成 80g，热量 267→214。同轮 `quantity_expr` 明明是"100克"、`portion_confidence` 0.95——信息都在，只是护栏缺失。模型行为有随机性：另一些响应形态正确返回 `[{grams:100, label:"custom"}]`，所以此 bug 间歇出现，更隐蔽。

## 做什么（三层防御，指引不限定细节）

1. **schema 层**：~~zod refine 硬拒绝触发 flash→pro 重试~~ → **实施时改为 transform 归一化**（`ensureChosenPortion`，schema.ts）。原因：硬拒绝在两个模型都返回坏形态时会走完重试链兜底成 chat，**整条记录丢失**，比记错更糟。归一化就地修复：`quantity_expr` 可提取精确数量（/(\d+(?:\.\d+)?)\s*(毫升|克|ml|g)/i）→ 补 custom 条目、chosen 指向它；提不出 → chosen 回退 medium。transform 挂在 `FoodItemSchema` 上，record.items 与 modify.append items 一次全覆盖。
2. **代码兜底层**：`processFoodItem` 的 `rawChosen`/`biasedChosen` 回退链从 `?? portions[0]` 改为 `?? medium ?? portions[0]`（归一化后理论不触发，纯防御）。
3. **prompt 层**：parser 提示词明确——chosen_label 指向的档必须真实存在于 portions；用户给精确克数/毫升时 portions 须含等值 custom 条目。

## 验收（已全部通过，2026-07-03）

- ✅ `npm run eval -- --case chunhuabing`：第 1 轮转绿（weight_g=100 原样入库），连跑两遍一致，known_fail 标记已删。
- ✅ 单测 8 个（src/ai/schema.test.ts）：补 custom 条目（克/ml/中文单位/小数）、无数量回退 medium、无 medium 回退首档、良构原样返回、record 与 modify.append 两路径均归一化。后端 74/74 全绿。
- ✅ 全量 eval 回归：新回归 0，已知缺陷 3（均归属 T40）。
