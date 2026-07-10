# T59 — 显式记忆请求必存：「你得记住」不允许被丢弃

**状态**：✅完成（2026-07-10）

**目标**：用户明确说「记住/别忘了/以后都按…」时，语义记忆系统**必须**产出一条 UserMemory，且下轮对话可见可用。同时给「记录约定/表达习惯」类事实（如「我说的主食都是熟重」）在五类体系里安排位置，不再被「绝不提取：对 AI 的纠正」误伤。

**依赖**：T55（提取管线）。碰 `services/memory-extract.ts`（词表 + 两个 prompt）。
**关注文档**：`MEMORY_SPEC.md` §4（提取管线）。

## 背景（2026-07-09 真机，账号 outoftoken）

14:38 用户说「**我说的都是熟的饭，谁没事吃生的，这个你得记住**」，14:43 追问「你这是记下了？」，14:44 再问「你记住这个习惯不就好了？」——连续三轮显式要求记忆。结果 UserMemory **一条都没存**（事后查库只有 7-07 的 3 条旧记忆）。AI 先答应「明白了会记住」，后改口「后台系统不是实时学习的」，承诺与现实双向翻车。

丢失路径复盘（`memory-extract.ts`）：
1. 14:38 那句**一个触发词都不命中**——词表里没有「记住/别忘了/生重/熟重」；quick 路径直接跳过。
2. 14:43「习惯」命中触发了提取，但 FULL prompt「绝不提取」清单明确排除「对 AI 的纠正」，且五类类型没有「记录约定」的位置——LLM 按 prompt 正确地丢弃了它。

## 设计要点

### A. 词表补显式记忆信号
`CONSTRAINT_KEYWORDS`（quick 路径同用）增加：`记住`、`别忘了`、`记下`、`以后都`、`下次都`、`生重`、`熟重`、`熟的`。宁松勿紧，LLM 是闸门。

### B. 两个提取 prompt 增加「显式记忆请求」规则
- 新增规则（放在「绝不提取」之前，优先级更高）：**用户明确要求记住的内容必须提取**（「记住」「别忘了」「以后都按X理解」），即使它看起来像对 AI 的纠正或操作指令。置信度按明确陈述给 0.90+，importance_class=strong。
- 「绝不提取：对 AI 的纠正」补充限定：*仅指未要求记住的单次纠正*（「你估太多了应该是100g」）。
- 增加「记录约定/表达习惯」示例，归入 preference：
  `"我说的主食都是熟重" → {type:"preference", entity:"cooked_weight_reporting", content:"主食重量均按熟重理解", importance_class:"strong"}`
- 受控 entity 词表增加 `cooked_weight_reporting(熟重报量)`。

### C. 验证注入链路真的生效
`buildMemoryPack` → `renderMemorySection`（ctx.ts【关于你】段）已注入 prefsHabits，确认：
- 该记忆能进入 parser 与 chat 回复的 prompt（strong 记忆在 score 排序中不被挤出前 8）；
- 下轮问「你记得我说的熟重吗」，AI 能引用该记忆回答（配合 T58 的系统事实段，不再出现「我记不住」式回答）。

## 验收
1. 发「我说的都是熟的饭，这个你得记住」→ UserMemory 新增 preference `cooked_weight_reporting`（strong，confidence ≥0.9）。
2. 下轮问「你记得我之前说的生熟问题吗」→ 回答引用该记忆。
3. 负例不误伤：「把牛肉面改成大份」「你估太多了，应该是100g」（未要求记住）仍不产生记忆。
4. `npm test`（memory-extract / memory-scorer 相关单测，含新增用例）通过。
5. `cd backend && npm run eval` 全绿（起干净端口，别打 :9300）。

## 提示词（可粘贴）
> 按本文件「设计要点 A→B→C」执行 T59。改 `backend/src/services/memory-extract.ts` 的词表与两个 prompt；C 步在本地起服务用真实请求验证记忆写入与下轮注入（可用 curl 按 `docs/TEST_PLAN.md` 流程）。prompt 改动保持现有结构与措辞风格，不推倒重写。完成后补单测跑 `npm test`，再跑 `npm run eval`（干净端口）。遵守 CLAUDE.md 铁律 10/12。
