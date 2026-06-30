# T24 — 食物匹配裁决层：字面只召回，AI 裁决（修「蛋白→蛋白粉」误匹配）

**状态**：✅完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：修字面误匹配——`matchFood` 的前缀/trgm 命中直接当裁决，把「蛋白」（蛋清）撞成「蛋白粉」(425kcal)。改为：精确/alias 可信任直用；前缀/trgm 属弱匹配需 AI 把关；否决则估算。
**依赖**：T05　**关注文档**：AI_PARSING_SPEC §3 §5

## 根因（实测）
- 真凶是**前缀匹配**：「蛋白」是「蛋白粉」字面前缀，`matchFood` 第③步直接返回，不经 AI。trgm 相似度仅 0.14（<0.4），清白。
- 叠加：AI canonical 不稳定，时而「蛋白」（泛词撞前缀）时而「鸡蛋白」（精确命中蛋类）。

## 做什么
- `matchFood(canonical, raw?)` 分层（AI_PARSING_SPEC §5）：
  ① 精确 / ② alias → 可信直用（零额外调用）。
  ③ 前缀：仅当「真 specialization」（name==canonical，或 canonical 之后紧跟分隔符 `（(空格、，`）才直用（保留 纯牛奶→纯牛奶（…）、代表值优先）；否则（假前缀如蛋白粉）转「可疑候选」。
  ④ trgm≥0.4 命中 → 也进「可疑候选」。
  ⑤ 无任何候选 → AI 估算落库。
  ⑥ 有可疑候选 → 回灌 DeepSeek 裁决（带**用户原话 raw** + canonical + 候选名/类目/热量）。
       - 类目只作 AI 的判断信息，**不硬排除**（category 取自文件名，粗，不给一票否决）。
       - **「以上都不是」为显式一等选项**，选它直接走 ⑤ 估算，不诱导硬选。
  ⑦ AI 否决 → AI 估算落库（is_estimated=true）。
- **parse prompt 主修之一**：给易撞词归一示例（蛋白→鸡蛋白、蛋清→鸡蛋白 等），从源头减少撞前缀。
- 调用方补传 raw：`processFoodItem`、resolve(food_choice)、modify(change.food)。
- 不动 `matchFoodCandidates` / 煎饼一对多歧义链路（那是另一个病）。

## 验收
- 「水煮蛋吃了一个整蛋和一个蛋白」：
  - canonical=鸡蛋白 → 精确命中蛋类（~60kcal/100g），不是蛋白粉。
  - canonical=蛋白 → 可疑前缀 → AI 否决蛋白粉 → 估蛋清。
  - 两条路径都**不得**记成蛋白粉(425/100g)。
- 回归：纯牛奶→纯牛奶（全脂…）、常见食物仍零额外裁决调用。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/AI_PARSING_SPEC.md §3 §5。只做任务 T24：matchFood 加 AI 裁决层（前缀分真假、弱匹配回灌 DeepSeek、"以上都不是"一等选项直通估算、类目仅降权不否决），parse prompt 加易撞词归一示例。用「一个蛋白」两条 canonical 路径验证都不记成蛋白粉，且纯牛奶等回归正常。
