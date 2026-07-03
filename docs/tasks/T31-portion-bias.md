# T31 — 份量偏差学习（P3：核心闭环，克数越用越准）

**状态**：✅完成

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

## 实现记录（非显而易见的坑）

- **加了规划外的一列 `food_record.predicted_grams`（AI 原估，applyBias 前），原因是一个数学稳定性问题**：隐式确认 job 只有 food_record 可读，而 weight_g 是偏差修正后的值。若 job 把 `predicted=final=weight_g` 记进事件（T29 的做法），e≡0，会持续把 μ 往 0 拉——**用户越沉默、学到的偏差被侵蚀越快，最后克数漂回原估，用户被迫重新纠正，形成振荡**。正确语义：用户静置=接受了修正值，证据应为 `e=ln(applied/raw)`，强化而非侵蚀偏差。这需要 raw 在 24h 后仍可读，故落列。副产物：discuss 注入直接读该列即可（比查 learning_event 简单，且覆盖尚无事件的 auto_commit 记录），LEARNING_SPEC §7 已同步。
- **同理，resolve 场景用户接受偏差后的档位时**，事件记 `predicted=raw(350), final=biased(515)`，log_ratio=+0.386 → 强化。已实测确认。pending candidates 因此多存 `predicted_grams`/`applied_grams` 两个字段（portions 本身存偏差后的值，展示与入库一致）。
- **候选卡路径没法在建卡时应用偏差**（食物未知），改在 food_choice→portion_choice 两步转换时应用（此刻食物已定）——`pending.ts` 的 food_choice 分支。
- **两道污染防线会叠加**（设计如此，单测时差点当 bug）：截断后的观测（ln3≈1.1）相对冷启动先验（σ≈0.36）仍偏离 >2σ，离群降权同时触发，w=0.5。实测"9999克"单次污染只把 μ 从 0.311 推到 0.411，应用侧硬边界仍守住 ≤1.8×。
- **份量习惯行有显著性门槛**：|μ|≥0.15 且 n_eff≥2 才进 prompt（防噪声）；`LEARNING_BIAS=off` 同时关掉数值修正与习惯行（单开关语义完整）。
- 端到端实测：3 次"改成500克"（原估350）→ μ=0.311（真值0.357，收敛正常）→ 再记同食物 465g（trust 渐进，未到完全修正 478g）→ 份量卡三档 370/515/660 全部上调 → resolve 接受 → 事件强化闭环 → discuss 如实解释"基于历史份量纠正习惯的自动调整"无幻觉 → `LEARNING_BIAS=off` 恢复 350g 原估。算法层 13 条单测覆盖全部 §5 性质。
