import { prisma } from "../lib/prisma";
import { todayStr, toDateOnly } from "../lib/dates";

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
