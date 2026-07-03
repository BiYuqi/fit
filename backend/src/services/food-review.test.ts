import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  checkEnergy,
  evaluateReview,
  ENERGY_DIFF_MAX,
  CATEGORY_OUTLIER_RATIO,
  type ReviewEstimate,
} from "./food-review";

// ═══ 能量自检（4/4/9 口径，同 T03）═══

test("能量自检：自洽的估算通过（黄焖鸡量级）", () => {
  // 4*12 + 4*8 + 9*9 = 161 vs 标注 160 → 偏差 <1%
  const v: ReviewEstimate = { calories_100g: 160, protein_100g: 12, fat_100g: 9, carbs_100g: 8 };
  const chk = checkEnergy(v);
  assert.ok(chk.ok);
  assert.ok(chk.diffPct < 0.01);
});

test("能量自检：热量与三大营养素不符则不通过", () => {
  // 4*5 + 4*10 + 9*2 = 78，标注 400 → 偏差远超 25%
  const v: ReviewEstimate = { calories_100g: 400, protein_100g: 5, fat_100g: 2, carbs_100g: 10 };
  const chk = checkEnergy(v);
  assert.equal(chk.ok, false);
  assert.ok(chk.diffPct > ENERGY_DIFF_MAX);
  assert.equal(evaluateReview(v, null), "rejected_energy_check");
});

test("能量自检：恰在 25% 阈值边界内通过", () => {
  // predicted = 4*10 + 4*10 + 9*0 = 80，标注 100 → 偏差恰 20% ≤ 25%
  const v: ReviewEstimate = { calories_100g: 100, protein_100g: 10, fat_100g: 0, carbs_100g: 10 };
  assert.ok(checkEnergy(v).ok);
});

// ═══ 类目均值离群校验 ═══

test("类目离群：超均值 3 倍拒绝，3 倍内通过", () => {
  // 自洽估算：4*20+4*20+9*40 = 520
  const high: ReviewEstimate = { calories_100g: 520, protein_100g: 20, fat_100g: 40, carbs_100g: 20 };
  assert.equal(evaluateReview(high, 150), "rejected_category_outlier"); // 520/150 ≈ 3.5 > 3
  assert.equal(evaluateReview(high, 200), "updated"); // 520/200 = 2.6 < 3
});

test("类目离群：低于均值 1/3 也拒绝（双向）", () => {
  // 自洽估算：4*2+4*5+9*0.4 ≈ 31.6 → 标 30
  const low: ReviewEstimate = { calories_100g: 30, protein_100g: 2, fat_100g: 0.4, carbs_100g: 5 };
  assert.equal(evaluateReview(low, 30 * CATEGORY_OUTLIER_RATIO + 10), "rejected_category_outlier");
  assert.equal(evaluateReview(low, 60), "updated");
});

test("类目无标准层条目（categoryMean=null）：跳过离群校验，只做能量自检", () => {
  const v: ReviewEstimate = { calories_100g: 900, protein_100g: 5, fat_100g: 95, carbs_100g: 5 };
  // 4*5+4*5+9*95 = 895 ≈ 900 自洽 → 无参照时不因数值大而拒
  assert.equal(evaluateReview(v, null), "updated");
});

test("护栏顺序：能量自检优先于类目离群", () => {
  const v: ReviewEstimate = { calories_100g: 900, protein_100g: 5, fat_100g: 2, carbs_100g: 10 };
  assert.equal(evaluateReview(v, 100), "rejected_energy_check");
});
