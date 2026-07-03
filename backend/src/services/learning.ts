import { prisma } from "../lib/prisma";
import { todayStr, toDateOnly } from "../lib/dates";
import type { UserFoodAlias } from "@prisma/client";

// ---------- 学习信号采集（LEARNING_SPEC §3）----------
// P1（T29）：只采集不应用。applied_grams 恒等于 predicted_grams，
// 直到 T31 接入 applyBias 后才会分叉。

export type SignalType = "explicit_gram" | "custom_gram" | "card_choice" | "implicit_accept" | "delete";

const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  explicit_gram: 1.0,
  custom_gram: 0.9,
  card_choice: 0.6,
  implicit_accept: 0.15,
  delete: 0,
};

// scene 层只认这三个值：unknown/null 不建 bias 行、不参与融合（LEARNING_SPEC §4，T32）
const BIAS_SCENES = new Set(["takeout", "canteen", "home"]);
function sceneScopeKey(scene: string | null | undefined): string | null {
  return scene && BIAS_SCENES.has(scene) ? scene : null;
}

export interface LearningEventInput {
  user_id: string;
  food_record_id?: string | null;
  food_id?: string | null;
  category?: string | null;
  scene?: string | null;
  predicted_grams: number;
  applied_grams?: number; // applyBias 之后展示给用户的克数；缺省 = predicted（无修正）
  final_grams: number;
  predicted_label?: string | null;
  final_label?: string | null;
  signal_type: SignalType;
  parse_log_id?: string | null;
}

// 学习信号写入失败不影响主流程——异常一律吞掉，只在测试/排查时靠日志发现。
// 写入后立即在线更新 user_bias（LEARNING_SPEC §5）——事件即训练，无独立训练管线。
export async function recordLearningEvent(ev: LearningEventInput): Promise<void> {
  try {
    const signal_weight = SIGNAL_WEIGHTS[ev.signal_type];
    const log_ratio =
      ev.predicted_grams > 0 && ev.final_grams > 0
        ? Math.log(ev.final_grams / ev.predicted_grams)
        : null;

    const event = await prisma.learningEvent.create({
      data: {
        user_id: ev.user_id,
        food_record_id: ev.food_record_id ?? null,
        food_id: ev.food_id ?? null,
        category: ev.category ?? null,
        scene: ev.scene ?? null,
        predicted_grams: ev.predicted_grams,
        applied_grams: ev.applied_grams ?? ev.predicted_grams,
        final_grams: ev.final_grams,
        predicted_label: ev.predicted_label ?? null,
        final_label: ev.final_label ?? null,
        signal_type: ev.signal_type,
        signal_weight,
        log_ratio,
        parse_log_id: ev.parse_log_id ?? null,
      },
    });

    // 权重为 0（delete）或误差不可算的事件只留档不训练
    if (signal_weight > 0 && log_ratio != null) {
      await updateBiasForEvent(event.id, ev.user_id, log_ratio, signal_weight, {
        food_id: ev.food_id ?? null,
        category: ev.category ?? null,
        scene: ev.scene ?? null,
      });
    }
  } catch {
    // 静默失败，不影响主流程
  }
}

// ---------- 体重历史（LEARNING_SPEC §8，T34 消费）----------
// 设置页改体重时后端顺手 append，用户无感知。同一天多次更新覆盖当天那一行。
export async function upsertWeightLog(user_id: string, weight_kg: number): Promise<void> {
  try {
    const date = toDateOnly(todayStr());
    await prisma.weightLog.upsert({
      where: { user_id_date: { user_id, date } },
      update: { weight_kg },
      create: { user_id, date, weight_kg },
    });
  } catch {
    // 静默失败，不影响主流程
  }
}

// ---------- 隐式确认（LEARNING_SPEC §3）----------
// 每日跑一次：入库超 hoursThreshold 小时、且从未产生过 learning_event 的 food_record
// （auto_commit 直接入库、从未经过 resolve/modify）视为隐式确认，记一条低权重信号。
export async function runImplicitAcceptJob(hoursThreshold = 24): Promise<number> {
  const cutoff = new Date(Date.now() - hoursThreshold * 3600 * 1000);
  const candidates = await prisma.foodRecord.findMany({
    where: {
      created_at: { lt: cutoff },
      learning_events: { none: {} },
    },
    include: { food: true },
  });

  for (const fr of candidates) {
    // predicted 用 AI 原估（predicted_grams，T31 起有值），不用 weight_g：
    // 若 weight_g 是 applyBias 调整后的值，用户静置=接受了调整，误差应为 ln(applied/raw)
    // ——强化已学到的偏差；若用 weight_g 当 predicted，e 恒为 0，会把 μ 往 0 拉、侵蚀偏差。
    await recordLearningEvent({
      user_id: fr.user_id,
      food_record_id: fr.id,
      food_id: fr.food_id,
      category: fr.food?.category ?? null,
      predicted_grams: fr.predicted_grams ?? fr.weight_g,
      applied_grams: fr.weight_g,
      final_grams: fr.weight_g,
      predicted_label: fr.portion_label,
      final_label: fr.portion_label,
      signal_type: "implicit_accept",
      scene: fr.scene,
    });
  }

  return candidates.length;
}

// ---------- 用户食物直连（LEARNING_SPEC §6 §7，T30）----------
// canonical → 用户惯用的 food_id。streak≥2 时 food-item.ts 跳过 CandidateCard 直用该食物。

// 读：路由决策用，失败/无记录一律返回 null，调用方回退到正常匹配流程。
export async function getFoodAlias(user_id: string, canonical: string): Promise<UserFoodAlias | null> {
  try {
    return await prisma.userFoodAlias.findUnique({
      where: { user_id_canonical: { user_id, canonical } },
    });
  } catch {
    return null;
  }
}

// 写：用户在 CandidateCard 选定食物时调用。选同一食物 → streak+1；换了别的 → streak 归 1。
export async function upsertFoodAlias(user_id: string, canonical: string, food_id: string): Promise<void> {
  try {
    const existing = await prisma.userFoodAlias.findUnique({
      where: { user_id_canonical: { user_id, canonical } },
    });
    if (existing && existing.food_id === food_id) {
      await prisma.userFoodAlias.update({
        where: { user_id_canonical: { user_id, canonical } },
        data: { hits: { increment: 1 }, streak: { increment: 1 }, last_chosen_at: new Date() },
      });
    } else {
      await prisma.userFoodAlias.upsert({
        where: { user_id_canonical: { user_id, canonical } },
        update: { food_id, hits: { increment: 1 }, streak: 1, last_chosen_at: new Date() },
        create: { user_id, canonical, food_id, hits: 1, streak: 1 },
      });
    }
  } catch {
    // 静默失败，不影响主流程
  }
}

// 清零：逃生口点击 / undo 撤销 / modify 改食物 时调用。不动 food_id/hits，只清 streak，
// 需要再连续选够 streak 次才会重新触发跳卡——不是删记录，是"重新观察"。
export async function resetFoodAliasStreak(user_id: string, canonical: string): Promise<void> {
  try {
    await prisma.userFoodAlias.updateMany({
      where: { user_id, canonical },
      data: { streak: 0 },
    });
  } catch {
    // 静默失败，不影响主流程
  }
}

// ---------- 份量偏差学习（LEARNING_SPEC §4 §5，T31）----------
// 误差 = log 克数比 e = ln(final/predicted)。每层维护正态后验 (μ, σ², n_eff)。
// 常数是 LEARNING_SPEC §5 的唯一实现，改动须同步文档。

export const PRIOR_SIGMA2 = 0.09; // 先验方差：ln²(1.35)，默认信 AI ±35%
export const OBS_SIGMA2 = 0.04; // 单次观测噪声（用户自己也估不准）
export const N_EFF_CAP = 20; // 有效样本封顶 → 永远保留可塑性，防僵化
export const CLAMP = Math.log(3); // 单次观测截断 ±ln(3)，防污染
export const MULT_RANGE: [number, number] = [0.6, 1.8]; // 最终修正倍率硬边界，防漂移
export const TRUST_K = 4; // 修正强度渐进：证据≈4 次时用一半力

export interface Bias {
  mu: number;
  sigma2: number;
  n_eff: number;
}

export const DEFAULT_BIAS: Bias = { mu: 0, sigma2: PRIOR_SIGMA2, n_eff: 0 };

// ── 更新（纯函数，供单测）：一次观测的 Bayesian 共轭更新 ──
export function updateBias(prior: Bias, e: number, signalWeight: number): { post: Bias; clamped: boolean } {
  // 1. 污染防护：截断离谱观测（"改成9999克"或手滑）
  const eClamped = Math.max(-CLAMP, Math.min(CLAMP, e));
  const clamped = eClamped !== e;
  // 2. 离群降权：偏离当前后验 >2σ 的观测，权重再砍半（不拒绝，只怀疑）
  const dev = Math.abs(eClamped - prior.mu) / Math.sqrt(prior.sigma2 + OBS_SIGMA2);
  const w = signalWeight * (dev > 2 ? 0.5 : 1);
  // 3. 精度加权平均——数学上等价于自适应 EMA：数据少时步长大，数据多时步长小
  const precPrior = 1 / prior.sigma2;
  const precObs = w / OBS_SIGMA2;
  const mu = (precPrior * prior.mu + precObs * eClamped) / (precPrior + precObs);
  const sigma2Raw = 1 / (precPrior + precObs);
  // 4. 防漂移：n_eff 封顶 = 观测计数带遗忘；σ² 保底 → 模型永远"愿意改主意"
  const n_eff = Math.min(prior.n_eff + w, N_EFF_CAP);
  return {
    post: { mu, sigma2: Math.max(sigma2Raw, PRIOR_SIGMA2 / N_EFF_CAP), n_eff },
    clamped,
  };
}

// ── 应用（纯函数，供单测）：分层收缩融合 + trust 渐进 + 硬边界 + 取整5g ──
export function applyBias(
  predictedGrams: number,
  biases: { food?: Bias | null; category?: Bias | null; scene?: Bias | null },
): number {
  // 按后验精度加权融合三层（哪层数据足，哪层说话响）；数据不足的层自动沉默
  let num = 0;
  let den = 0;
  for (const b of [biases.food, biases.category, biases.scene]) {
    if (!b || b.n_eff < 1) continue; // 至少 1 个有效观测才发言
    const prec = b.n_eff / b.sigma2;
    num += prec * b.mu;
    den += prec;
  }
  if (den === 0) return predictedGrams; // 冷启动：原样返回 AI 估算
  const muBlend = num / den;
  // 不确定时少改：修正强度随总证据量渐进（0→1），证据≈TRUST_K 次时用一半力
  const trust = den / (den + TRUST_K / PRIOR_SIGMA2);
  const mult = Math.exp(muBlend * trust);
  const safe = Math.max(MULT_RANGE[0], Math.min(MULT_RANGE[1], mult));
  return Math.round((predictedGrams * safe) / 5) * 5; // 取整到 5g，显示友好
}

// 应用开关：LEARNING_BIAS=off 一键关闭克数修正（采集不受影响）
export function biasEnabled(): boolean {
  return process.env.LEARNING_BIAS !== "off";
}

// ── 持久化：读某用户对某食物的分层偏差（food + category + scene；unknown 场景无行自然沉默）──
export async function getBiases(
  user_id: string,
  food_id: string | null,
  category: string | null,
  scene?: string | null,
): Promise<{ food?: Bias | null; category?: Bias | null; scene?: Bias | null }> {
  try {
    const sceneKey = sceneScopeKey(scene);
    const keys: Array<{ scope: string; scope_key: string }> = [];
    if (food_id) keys.push({ scope: "food", scope_key: food_id });
    if (category) keys.push({ scope: "category", scope_key: category });
    if (sceneKey) keys.push({ scope: "scene", scope_key: sceneKey });
    if (keys.length === 0) return {};
    const rows = await prisma.userBias.findMany({
      where: { user_id, OR: keys },
    });
    return {
      food: rows.find((r) => r.scope === "food") ?? null,
      category: rows.find((r) => r.scope === "category") ?? null,
      scene: rows.find((r) => r.scope === "scene") ?? null,
    };
  } catch {
    return {};
  }
}

// 便捷入口：对一个克数应用该用户对该食物的学习偏差。开关关闭/无数据时原样返回。
export async function applyBiasToGrams(
  user_id: string,
  food_id: string | null,
  category: string | null,
  grams: number,
  scene?: string | null,
): Promise<number> {
  if (!biasEnabled()) return grams;
  const biases = await getBiases(user_id, food_id, category, scene);
  return applyBias(grams, biases);
}

// ── 在线更新：一个学习事件更新 food/category/scene 三层后验，前后状态写 bias_update_log ──
async function updateBiasForEvent(
  event_id: string,
  user_id: string,
  e: number,
  signalWeight: number,
  scopes: { food_id: string | null; category: string | null; scene?: string | null },
): Promise<void> {
  const sceneKey = sceneScopeKey(scopes.scene);
  const layers: Array<{ scope: string; scope_key: string }> = [];
  if (scopes.food_id) layers.push({ scope: "food", scope_key: scopes.food_id });
  if (scopes.category) layers.push({ scope: "category", scope_key: scopes.category });
  if (sceneKey) layers.push({ scope: "scene", scope_key: sceneKey });

  for (const { scope, scope_key } of layers) {
    const existing = await prisma.userBias.findUnique({
      where: { user_id_scope_scope_key: { user_id, scope, scope_key } },
    });
    const prior: Bias = existing ?? DEFAULT_BIAS;
    const { post, clamped } = updateBias(prior, e, signalWeight);

    await prisma.userBias.upsert({
      where: { user_id_scope_scope_key: { user_id, scope, scope_key } },
      update: { mu: post.mu, sigma2: post.sigma2, n_eff: post.n_eff },
      create: { user_id, scope, scope_key, mu: post.mu, sigma2: post.sigma2, n_eff: post.n_eff },
    });

    await prisma.biasUpdateLog.create({
      data: {
        event_id,
        user_id,
        scope,
        scope_key,
        mu_before: prior.mu,
        sigma2_before: prior.sigma2,
        n_eff_before: prior.n_eff,
        mu_after: post.mu,
        sigma2_after: post.sigma2,
        n_eff_after: post.n_eff,
        clamped,
      },
    });
  }
}
