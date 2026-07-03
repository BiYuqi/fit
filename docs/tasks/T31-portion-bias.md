# T31 — 份量偏差学习（P3：核心闭环，克数越用越准）

**状态**：⬜待办

**目标**：接通学习闭环的后三环：误差 → 更新 `user_bias`（food/category 两层）→ `applyBias` 修正下次预测克数。**discuss 提示词必改**（后端调了克数而 AI 不知道 → 幻觉解释）。
**依赖**：T29　**关注文档**：LEARNING_SPEC §4 §5 §6 §7（算法与常数的唯一定义处）

## 做什么
- Prisma 迁移：建 `user_bias` + `bias_update_log`。
- `services/learning.ts` 扩展：
  - `updateBias`（LEARNING_SPEC §5：Bayesian 精度加权 + 截断 + 离群降权 + n_eff 封顶 + σ² 保底），每个 learning_event 更新 food/category 两层（scene 层 T32 接入），前后状态写 bias_update_log。
  - `applyBias`（§5：分层精度加权融合 + trust 渐进 + 倍率硬边界 [0.6,1.8] + 取整5g）。
- **应用点**（services/food-item.ts）：parse 出 portions 后、出卡/入库前，对每档克数跑 applyBias；learning_event 从此 `applied_grams ≠ predicted_grams`，误差以 predicted（AI 原估）为基准。
- 环境变量 `LEARNING_BIAS=off` 一键关闭（默认 on）。
- **payload**：record_card / portion_card 加 `bias_applied:{from,to}`（未修正则省略）；前端不强制展示。
- **discuss 注入**（ai/answers.ts answerDiscuss）：按 record_id 查最近 learning_event，若 applied≠predicted，注入"AI 原估 Xg，按你的历史习惯调整为 Yg"。
- **【份量习惯】行**（services/memory.ts compressContext）：从 user_bias/learning_event 生成如"牛肉面:常选大份"，只影响 chosen_label，不给数字。

## 验收
- 单测：updateBias 常数与截断/降权/封顶行为符合 §5；applyBias 冷启动原样返回、证据充足时修正、倍率不越界。
- 端到端：对同一食物连续 3 次"改成500克"（AI 估 ~350g）后，再次记录该食物 → 卡片默认克数明显上移且 ≤1.8 倍；换 `LEARNING_BIAS=off` 恢复原估。
- discuss 问"为什么是这个克数" → 回复包含"按你的历史习惯调整"而非编造。
- 极端输入"改成9999克" → bias_update_log 该行 clamped=true，后续修正倍率仍在 [0.6,1.8] 内。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/LEARNING_SPEC.md §4-§7。只做任务 T31：user_bias/bias_update_log 表 + updateBias/applyBias（严格按 §5 常数）+ food-item 应用点 + LEARNING_BIAS 开关 + bias_applied payload + discuss 偏差注入 + compressContext 份量习惯行。验收含污染防护（9999克）与开关回退。
