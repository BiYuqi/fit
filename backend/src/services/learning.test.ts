import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  updateBias,
  applyBias,
  DEFAULT_BIAS,
  PRIOR_SIGMA2,
  OBS_SIGMA2,
  N_EFF_CAP,
  CLAMP,
  MULT_RANGE,
  TRUST_K,
  type Bias,
} from "./learning";

// ═══ updateBias（LEARNING_SPEC §5 Bayesian 更新）═══

test("首次观测：μ 向观测移动但不到位（先验仍占权重）", () => {
  const e = Math.log(500 / 350); // ≈ +0.357，用户真实份量比 AI 估的大
  const { post, clamped } = updateBias(DEFAULT_BIAS, e, 1.0);
  assert.equal(clamped, false);
  assert.ok(post.mu > 0 && post.mu < e, `μ=${post.mu} 应在 (0, ${e}) 之间`);
  // 精度加权手算：precPrior=1/0.09≈11.11, precObs=1/0.04=25 → μ = 25e/36.11
  const expected = ((1 / OBS_SIGMA2) * e) / (1 / PRIOR_SIGMA2 + 1 / OBS_SIGMA2);
  assert.ok(Math.abs(post.mu - expected) < 1e-9);
  assert.ok(post.sigma2 < PRIOR_SIGMA2, "观测后方差应收缩");
  assert.equal(post.n_eff, 1.0);
});

test("信号权重生效：弱信号（0.15）比强信号（1.0）更新更小", () => {
  const e = 0.3;
  const strong = updateBias(DEFAULT_BIAS, e, 1.0).post;
  const weak = updateBias(DEFAULT_BIAS, e, 0.15).post;
  assert.ok(weak.mu < strong.mu, "弱信号 μ 移动应更小");
  assert.ok(weak.n_eff < strong.n_eff);
});

test("污染防护：'改成9999克'级别的离谱观测被截断到 ±ln3，且叠加离群降权", () => {
  const e = Math.log(9999 / 150); // ≈ 4.2，远超 CLAMP≈1.1
  const { post, clamped } = updateBias(DEFAULT_BIAS, e, 1.0);
  assert.equal(clamped, true);
  // 两道防线叠加：截断到 CLAMP 后，相对冷启动先验（σ≈0.36）仍偏离 >2σ → 权重再砍半 w=0.5
  const w = 0.5;
  const expected = ((w / OBS_SIGMA2) * CLAMP) / (1 / PRIOR_SIGMA2 + w / OBS_SIGMA2);
  assert.ok(Math.abs(post.mu - expected) < 1e-9, `μ=${post.mu} expected=${expected}`);
  assert.ok(post.mu < CLAMP / 2 + 0.1, "单次污染观测撼动有限");
  assert.equal(post.n_eff, 0.5);
});

test("离群降权：偏离后验>2σ 的观测权重砍半（不拒绝，只怀疑）", () => {
  // 已收敛的后验：μ=0, σ² 很小 → 一个 0.8 的观测远超 2σ
  const converged: Bias = { mu: 0, sigma2: 0.005, n_eff: 10 };
  const outlier = updateBias(converged, 0.8, 1.0).post;
  // 同样观测喂给"未收敛"先验（σ² 大，0.8 不算离群）作对照
  const loose: Bias = { mu: 0, sigma2: 0.5, n_eff: 10 };
  const normal = updateBias(loose, 0.8, 1.0).post;
  // 离群时 n_eff 只加 0.5（权重砍半），正常时加 1
  assert.equal(outlier.n_eff, 10.5);
  assert.equal(normal.n_eff, 11);
});

test("防漂移：n_eff 封顶 20，σ² 有保底（永远愿意改主意）", () => {
  let b: Bias = DEFAULT_BIAS;
  for (let i = 0; i < 50; i++) {
    b = updateBias(b, 0.2, 1.0).post;
  }
  assert.equal(b.n_eff, N_EFF_CAP);
  assert.ok(b.sigma2 >= PRIOR_SIGMA2 / N_EFF_CAP - 1e-12, `σ²=${b.sigma2} 应≥保底值`);
});

test("收敛性：持续一致的纠正让 μ 逼近真实偏差", () => {
  const trueBias = Math.log(500 / 350);
  let b: Bias = DEFAULT_BIAS;
  for (let i = 0; i < 10; i++) {
    b = updateBias(b, trueBias, 1.0).post;
  }
  assert.ok(Math.abs(b.mu - trueBias) < 0.05, `10次一致纠正后 μ=${b.mu} 应≈${trueBias}`);
});

// ═══ applyBias（LEARNING_SPEC §5 分层收缩融合）═══

test("冷启动：无任何偏差数据 → 原样返回 AI 估算", () => {
  assert.equal(applyBias(350, {}), 350);
  assert.equal(applyBias(350, { food: null, category: null }), 350);
});

test("n_eff<1 的层不发言（低数据不修正）", () => {
  const weak: Bias = { mu: 0.5, sigma2: 0.05, n_eff: 0.6 };
  assert.equal(applyBias(350, { food: weak }), 350);
});

test("证据充足时向学到的偏差方向修正，且不超原始 μ 对应倍率", () => {
  // 模拟 5 次一致强纠正后的后验
  let b: Bias = DEFAULT_BIAS;
  const e = Math.log(500 / 350);
  for (let i = 0; i < 5; i++) b = updateBias(b, e, 1.0).post;

  const adjusted = applyBias(350, { food: b });
  assert.ok(adjusted > 350, `应上调，got ${adjusted}`);
  assert.ok(adjusted <= 500, `trust<1 时不应超过完全修正值，got ${adjusted}`);
  assert.equal(adjusted % 5, 0, "取整到 5g");
});

test("trust 渐进：证据越多修正越接近完全值", () => {
  const e = Math.log(500 / 350);
  let few: Bias = DEFAULT_BIAS;
  for (let i = 0; i < 2; i++) few = updateBias(few, e, 1.0).post;
  let many: Bias = DEFAULT_BIAS;
  for (let i = 0; i < 15; i++) many = updateBias(many, e, 1.0).post;

  const adjFew = applyBias(350, { food: few });
  const adjMany = applyBias(350, { food: many });
  assert.ok(adjMany > adjFew, `证据多者修正应更大：few=${adjFew}, many=${adjMany}`);
});

test("倍率硬边界 [0.6, 1.8]：极端后验也不越界", () => {
  const extreme: Bias = { mu: 5, sigma2: PRIOR_SIGMA2 / N_EFF_CAP, n_eff: N_EFF_CAP };
  const up = applyBias(100, { food: extreme });
  assert.ok(up <= 100 * MULT_RANGE[1], `上界：${up} 应≤${100 * MULT_RANGE[1]}`);

  const extremeDown: Bias = { mu: -5, sigma2: PRIOR_SIGMA2 / N_EFF_CAP, n_eff: N_EFF_CAP };
  const down = applyBias(100, { food: extremeDown });
  assert.ok(down >= 100 * MULT_RANGE[0], `下界：${down} 应≥${100 * MULT_RANGE[0]}`);
});

test("分层收缩：food 层数据足时主导；只有 category 层时也能修正", () => {
  const food: Bias = { mu: 0.4, sigma2: 0.01, n_eff: 10 };
  const category: Bias = { mu: -0.2, sigma2: 0.02, n_eff: 5 };
  const both = applyBias(200, { food, category });
  const foodOnly = applyBias(200, { food });
  const catOnly = applyBias(200, { category });

  assert.ok(catOnly < 200, "只有 category 负偏差 → 下调");
  assert.ok(foodOnly > 200, "只有 food 正偏差 → 上调");
  // food 精度(10/0.01=1000) >> category(5/0.02=250) → 融合结果靠近 food 方向
  assert.ok(both > 200, `food 层应主导：${both}`);
});

test("scene 层参与融合（T32）：同食物在不同场景偏差下修正结果不同", () => {
  // 用户外卖场景系统性偏大（油多量足），自制场景偏小
  const takeout: Bias = { mu: 0.3, sigma2: 0.02, n_eff: 6 };
  const home: Bias = { mu: -0.2, sigma2: 0.02, n_eff: 6 };
  const atTakeout = applyBias(400, { scene: takeout });
  const atHome = applyBias(400, { scene: home });
  assert.ok(atTakeout > 400, `takeout 正偏差应上调：${atTakeout}`);
  assert.ok(atHome < 400, `home 负偏差应下调：${atHome}`);
  assert.notEqual(atTakeout, atHome);
  // unknown 场景（无 scene bias）不受影响
  assert.equal(applyBias(400, {}), 400);
  assert.equal(applyBias(400, { scene: null }), 400);
});

test("TRUST_K 语义：单层精度恰为 TRUST_K/PRIOR_SIGMA2 时 trust=0.5", () => {
  // 构造 n_eff/sigma2 = TRUST_K/PRIOR_SIGMA2 的层
  const b: Bias = { mu: 0.4, sigma2: 0.09, n_eff: TRUST_K };
  const adjusted = applyBias(1000, { food: b });
  // trust=0.5 → mult=exp(0.2)≈1.2214 → 1221.4 → 取整 1220
  assert.equal(adjusted, Math.round((1000 * Math.exp(0.2)) / 5) * 5);
});