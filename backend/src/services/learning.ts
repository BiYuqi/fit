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

export interface LearningEventInput {
  user_id: string;
  food_record_id?: string | null;
  food_id?: string | null;
  category?: string | null;
  predicted_grams: number;
  final_grams: number;
  predicted_label?: string | null;
  final_label?: string | null;
  signal_type: SignalType;
  parse_log_id?: string | null;
}

// 学习信号写入失败不影响主流程——异常一律吞掉，只在测试/排查时靠日志发现。
export async function recordLearningEvent(ev: LearningEventInput): Promise<void> {
  try {
    const signal_weight = SIGNAL_WEIGHTS[ev.signal_type];
    const log_ratio =
      ev.predicted_grams > 0 && ev.final_grams > 0
        ? Math.log(ev.final_grams / ev.predicted_grams)
        : null;

    await prisma.learningEvent.create({
      data: {
        user_id: ev.user_id,
        food_record_id: ev.food_record_id ?? null,
        food_id: ev.food_id ?? null,
        category: ev.category ?? null,
        predicted_grams: ev.predicted_grams,
        applied_grams: ev.predicted_grams, // T31 前恒等于 predicted_grams（applyBias 尚不存在）
        final_grams: ev.final_grams,
        predicted_label: ev.predicted_label ?? null,
        final_label: ev.final_label ?? null,
        signal_type: ev.signal_type,
        signal_weight,
        log_ratio,
        parse_log_id: ev.parse_log_id ?? null,
      },
    });
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
    await recordLearningEvent({
      user_id: fr.user_id,
      food_record_id: fr.id,
      food_id: fr.food_id,
      category: fr.food?.category ?? null,
      predicted_grams: fr.weight_g,
      final_grams: fr.weight_g,
      predicted_label: fr.portion_label,
      final_label: fr.portion_label,
      signal_type: "implicit_accept",
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
