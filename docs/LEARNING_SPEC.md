# LEARNING_SPEC — 自学习机制（越用越准）

> 本文件是学习系统的**唯一定义处**：学习信号、偏差模型、更新/应用算法、配套交互变更。
> 表字段定义在 DATA_MODEL（§学习系统表），TDEE 校准公式在 CALORIE_ENGINE，此处只引用。
> 任务拆分见 TASKS.md 分轨 L（T28–T34）。

## 0. 原则（不破铁律）

- **铁律 1 不破**：AI 仍只负责理解与估份量；偏差修正是**后端确定性数值计算**（属"后端算账"），不靠 prompt 注入数字。
- **旁路接入**：信号采集是旁路写，主流程零改动；偏差应用是 parse 之后的一个纯函数，`LEARNING_BIAS` 环境变量可一键关闭。
- **删聊天不影响学习**：学习只读写事实源侧的表（learning_event 等），与 chat_message 无关。

## 1. 问题：闭环缺三环

学习闭环 = 预测 → 结果 → 误差 → 参数更新 → 影响下次预测。现状：预测有（AI 估 portions 克数）、结果散落（pending resolve、modify 的 prev_state），**误差计算 / 可更新参数 / 回灌预测三环全缺**——系统里不存在任何一个会被用户行为改变的数值。附带病：同一句"一碗牛肉面"每次克数不可复现。

## 2. 架构：旁路 Bias Layer

```
parser(DeepSeek) 估 portions
      │
  ①applyBias（纯函数）──读 user_bias / user_food_alias
      │                  调整克数；alias streak≥2 跳候选卡
      ▼
现有路由（自动入库 / PortionCard / CandidateCard）
      │
用户动作（resolve 选择 / modify 改克数 / 静置24h / 删除）
      │
  ②recordLearningEvent ──→ learning_event（append-only）
  ③updateBias（在线）  ──→ user_bias（+ bias_update_log）
```

## 3. 学习信号分级

| 信号 | 来源 | 权重 | 说明 |
|---|---|---|---|
| 显式克数（打字"改成50克"） | modify update `change.grams` | 1.0 | 最强 |
| 显式克数（卡片自定义输入） | resolve `portion_label=custom` | 0.9 | 用户亲手输的数 |
| 卡片份量选择（小/中/大） | resolve portion_choice | 0.6 | 三选一有选择噪声 |
| 卡片食物选择 | resolve food_choice | — | 走 user_food_alias，不进克数偏差 |
| 隐式确认（入库 24h 未改未删） | 每日 job 扫 food_record | 0.15 | 用户懒得反馈时仍能收敛 |
| 删除 | delete resolve | 0 | **不训练**（动机不可知），只记事件 |
| 热量直接指定（"记录成180kcal"） | modify update `change.calories` | 0 | 用户真值覆盖（T40），克数没变，**不训练**克数偏差，只记档 |
| 属性修正（无油/去皮等） | modify update `change.food_desc` | 0 | 触发重估新食物条目 + 食物直连自愈（T40），**不训练**克数偏差，只记档 |

## 4. 三层偏差模型（分层收缩）

每层一行后验分布 `(μ, σ², n_eff)`，学的是 **log 克数比** `e = ln(final_g / predicted_g)`：

| 层 | scope_key | 学什么 | 数据不足时退回 |
|---|---|---|---|
| food | food_id | 该用户的这个食物通常多重 | ↓ category |
| category | 类目名 | 该用户该类食物的份量倾向 | ↓ scene |
| scene | takeout/canteen/home | 该用户该场景的系统性偏差 | ↓ 0（不修正） |

低数据启动与逐步变准是同一机制：融合时按各层后验精度加权，新用户/新食物自动由上层说话，数据攒够后下层主导。

## 5. 算法（公式唯一定义处）

常数：

| 常数 | 值 | 含义 |
|---|---|---|
| PRIOR_SIGMA2 | 0.09 (≈ln²1.35) | 先验方差：默认信 AI ±35% |
| OBS_SIGMA2 | 0.04 | 单次观测噪声 |
| N_EFF_CAP | 20 | 有效样本封顶（防僵化=防漂移） |
| CLAMP | ln 3 | 单次观测截断（防污染） |
| MULT_RANGE | [0.6, 1.8] | 最终修正倍率硬边界 |
| TRUST_K | 4 | 修正强度渐进：证据≈4 次时用一半力 |

更新（每个 learning_event 对三层各跑一次）：

```ts
function updateBias(prior: Bias, e: number, signalWeight: number): Bias {
  const eC = clamp(e, -CLAMP, CLAMP);                       // 截断离谱观测
  const dev = Math.abs(eC - prior.mu) / Math.sqrt(prior.sigma2 + OBS_SIGMA2);
  const w = signalWeight * (dev > 2 ? 0.5 : 1);             // 离群降权不拒绝
  const p0 = 1 / prior.sigma2, p1 = w / OBS_SIGMA2;         // Bayesian 精度加权
  return {
    mu: (p0 * prior.mu + p1 * eC) / (p0 + p1),
    sigma2: Math.max(1 / (p0 + p1), PRIOR_SIGMA2 / N_EFF_CAP), // σ²保底→永远可改主意
    n_eff: Math.min(prior.n_eff + w, N_EFF_CAP),
  };
}
```

应用（parse 后、出卡/入库前，对每档 portion 克数）：

```ts
function applyBias(grams: number, b: { food?: Bias; category?: Bias; scene?: Bias }): number {
  let num = 0, den = 0;
  for (const x of [b.food, b.category, b.scene]) {
    if (!x || x.n_eff < 1) continue;          // 至少1个有效观测才发言
    const prec = x.n_eff / x.sigma2;
    num += prec * x.mu; den += prec;
  }
  if (den === 0) return grams;                // 冷启动：原样用 AI 估算
  const trust = den / (den + TRUST_K / PRIOR_SIGMA2);       // 证据不足少改
  const mult = clamp(Math.exp((num / den) * trust), ...MULT_RANGE);
  return Math.round(grams * mult / 5) * 5;    // 取整5g
}
```

防污染小结：截断 + 离群降权 + 倍率硬边界 + 删除不训练 + 信号分级权重。
防漂移小结：n_eff 封顶（等效滑动窗口）+ σ² 保底 + bias_update_log 可回放回滚。

## 6. 学到的东西如何影响下次预测（三路径）

1. **克数修正**（主路径，后端确定性）：applyBias 调整 portions 各档克数。
2. **食物直连**：`user_food_alias` 中 `(canonical→food_id)` **streak ≥ 2** 时跳过 CandidateCard 直接入库（配逃生口，见 §7）。
3. **提示词辅助**（只影响 chosen_label，不给数字）：`compressContext` 加一行【份量习惯】如"牛肉面:常选大份"。

## 7. 配套交互与提示词变更（必做，防半吊子）

| 变更 | 阶段 | 内容 |
|---|---|---|
| 逃生口 | T30 | 习惯直连的 record_card 带 `matched_by_habit:true`，文案"已按你的习惯记为「X」"，卡上「不是它？」→ 重弹 CandidateCard + streak 清零 |
| undo 联动 | T30 | 习惯直连记录被撤销 → 同时 streak 清零（UI 撤销了模型也要撤销）；modify 改食物同理清 streak |
| discuss 注入 | T31 | **必改，否则幻觉**：answerDiscuss 注入偏差说明（"AI 原估 420g，按你历史习惯调整为 480g"），数据取 `food_record.predicted_grams`（比查 learning_event 更简单，且覆盖尚无事件的 auto_commit 记录） |
| payload | T31 | record_card / portion_card 带 `bias_applied:{from,to}`，前端可不展示，discuss/debug 用 |
| 【份量习惯】 | T31 | compressContext 加一行 |
| scene 字段 | T32 | parser record 协议加 `scene`（strict schema + zod + prompt 示例），同步 AI_PARSING_SPEC §3 |
| 属性修正自愈 | T40 | modify.update change.food_desc 产生新估算条目后 `upsertFoodAlias(user, 原食物名→新food_id)`，streak 从 1 起，下次同名食物 streak≥2 后食物直连命中修正版；与 T30 逃生口/undo 联动共用同一套 alias 机制 |

parse 主提示词在 T29–T31 期间零改动。

## 8. 体重地面真值校准（T34）

设置页改体重时后端顺手 append `weight_log`（用户无感知，无新交互）。周级 job 对账：用 `Σ日缺口` 预测的体重变化 vs `weight_log` 实际变化，校准**用户的有效 TDEE**（不改任何饮食记录数值）。公式与护栏（记录完整度 ≥6天/周、日摄入合理性下限、两校准点间隔 ≥2~3 周、变化量小于水分噪声阈值则跳过）定义在 CALORIE_ENGINE（T34 时补）。更新机制复用 §5 updateBias。

## 9. 可观测指标（证明"越用越准"）

- 周级：`learning_event.|log_ratio|` 滚动中位数，按用户注册周龄分桶——曲线下降 = 在变聪明；T31 上线前后的 A/B 判据。
- 辅助：PortionCard 弹出率、CandidateCard 弹出率（应随 alias/bias 积累下降）。

## 10. 表清单（字段见 DATA_MODEL §学习系统表）

`learning_event`（预测vs实际，append-only）/ `user_bias`（三层后验）/ `user_food_alias`（食物直连）/ `bias_update_log`（更新审计）/ `weight_log`（体重历史）。
