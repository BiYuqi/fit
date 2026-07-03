# T42 — chosen_label 护栏：用户明示克数被静默改档（数据污染级）

**状态**：⬜待办（T41 评测集首日抓获，优先级高——静默写错数据，危害大于所有"笨"类问题）

**目标**：parser 返回的 `chosen_label` 在 `portions` 里找不到对应条目时，不再静默回退小份；用户明说的克数必须原样入库。
**依赖**：无　**关注文档**：AI_PARSING_SPEC §3、eval/cases/chunhuabing.yaml（第 1 轮）

## 背景（T41 回放器抓获，2026-07-03）

用例输入"晚上吃了100克葱花饼 煎的"。DeepSeek 部分响应形态为：`portions=[小80/中120/大160]` + `chosen_label="custom"`——**没有 custom 条目**。`food-item.ts` 中：

```ts
const rawChosen = portions.find((p) => p.label === chosen_label) ?? portions[0];
```

fallback 命中 `portions[0]`（小份 80g）→ 用户明示的 100g 被静默记成 80g，热量 267→214。同轮 `quantity_expr` 明明是"100克"、`portion_confidence` 0.95——信息都在，只是护栏缺失。模型行为有随机性：另一些响应形态正确返回 `[{grams:100, label:"custom"}]`，所以此 bug 间歇出现，更隐蔽。

## 做什么（三层防御，指引不限定细节）

1. **schema 层**：zod `ParseResultSchema` 加 refine——`chosen_label` 必须存在于 `portions` 的 label 集合。校验失败自然触发现有 flash→pro 重试链（chat.ts 已有）。
2. **代码兜底层**（pro 也犯错时的最后防线）：`processFoodItem` / `modify` 共用路径里，`chosen_label` 找不到条目时：若 `quantity_expr` 可提取明确数字（如 /(\d+(?:\.\d+)?)\s*(克|g|毫升|ml)/），用它构造 custom 条目；提取不出则回退 **medium**（不是 portions[0]，小份是最差默认）。
3. **prompt 层**：parser 提示词明确——用户给出精确克数/毫升时，portions 必须包含 `label:"custom"` 且 grams 等于该数值的条目，chosen_label 指向它。

## 验收

- `npm run eval -- --case chunhuabing`：第 1 轮转绿（weight_g=100），删除该轮 `known_fail: T42` 标记。
- 单测：schema refine 拒绝 chosen_label∉portions 的样本；兜底函数对「custom 缺失 + quantity_expr 含 100克」返回 100，对「无数字」返回 medium 档。
- 回归：全量 eval 无新回归；现有单测全绿。
