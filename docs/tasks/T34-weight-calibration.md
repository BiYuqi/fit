# T34 — 体重地面真值校准（P6：物理对账，长期收敛的终极闭环）

**状态**：⬜待办

**目标**：用 `weight_log`（T29 起积累）与累计缺口做周级对账，校准用户**有效 TDEE**——公式 TDEE 只是人群均值，个体代谢差异 ±15% 很常见。不改任何饮食记录数值。
**依赖**：T29（需已积累数周体重点）　**关注文档**：LEARNING_SPEC §8、CALORIE_ENGINE（校准公式随本任务补入，唯一定义处）

## 做什么
- CALORIE_ENGINE 补「TDEE 校准」节：`TDEE_观测 = 平均日摄入 + 7700×Δ体重(kg)/天数`；有效 TDEE 用 LEARNING_SPEC §5 的 updateBias 机制向观测值收敛（scope=global, scope_key='tdee'，学 log(TDEE_观测/TDEE_公式)）。
- 周级 job，护栏全部满足才产生一次校准观测：
  - 两个体重点间隔 ≥ 14 天；
  - 区间内记录完整度 ≥ 6 天/周（daily_summary 有值且 calories_in > 800 的天数）；
  - |Δ体重| 大于水分噪声阈值 0.5kg，否则跳过；
  - 单次观测对 TDEE 的隐含修正截断在 ±25%（复用 CLAMP 思路）。
- 应用：`recompute`（services/summary.ts）算 tdee 时乘校准因子；daily_summary/上下文卡自然生效，目标热量随之校准。
- Settings 页可显示"已按你的实际数据校准代谢"一行说明（可选）。

## 验收
- 构造数据：3 周 weight_log + 完整 daily_summary，摄入按公式应减 1.5kg 实际只减 0.7kg → 校准后有效 TDEE 下调、幅度 ≤25%；缺口/目标热量随 recompute 更新。
- 记录不完整的周（<6 天）不产生观测；Δ体重 0.3kg 跳过。
- 校准因子有界：连续极端数据下 TDEE 不会漂出 [0.7, 1.3]×公式值。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/LEARNING_SPEC.md §8、docs/CALORIE_ENGINE.md。只做任务 T34：CALORIE_ENGINE 补 TDEE 校准公式，周级对账 job（四条护栏）产生校准观测，updateBias(scope=global) 收敛有效 TDEE，recompute 应用。验收含护栏与有界性。
