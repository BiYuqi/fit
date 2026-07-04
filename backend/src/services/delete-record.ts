// T49：食物/运动记录的共享删除逻辑。modify.ts 的直删分支与 pending-resolve.ts 的
// delete_confirm（存量兼容）分支都调用这里，保证学习信号/L0 日志/重算/餐卡刷新只维护一份。
// 不在这里创建聊天消息——是否产出 event 消息由调用方决定（legacy delete_confirm 路径不产出，
// 见 pending-resolve.ts 注释），保持"文本先行、卡片跟随"的时序由调用方控制。
import { prisma } from "../lib/prisma";
import { recompute, buildContextCard, type ContextCard } from "./summary";
import { recordLearningEvent } from "./learning";
import { recordDeleteCorrection } from "./trace";
import { buildResolveLogData, type ResolveAction } from "./resolve-log";
import type { MealType } from "@prisma/client";

export type DeleteFoodSnapshot = {
  kind: "food";
  food_id: string;
  meal_type: MealType;
  portion_label: string;
  weight_g: number;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  food_confidence: number | null;
  portion_confidence: number | null;
  source: string;
  raw_input: string | null;
  alias_canonical: string | null;
  predicted_grams: number | null;
  scene: string | null;
  calories_source: string;
  date: string; // 记录归属日 YYYY-MM-DD（撤销重建时用，可与对话日不同）
};

export type DeleteExerciseSnapshot = {
  kind: "exercise";
  type: string;
  duration_min: number | null;
  calories_burned: number;
  source: string;
  raw_input: string | null;
  date: string;
};

export type DeleteSnapshot = DeleteFoodSnapshot | DeleteExerciseSnapshot;

export type ExecuteDeleteResult =
  | {
      ok: true;
      summary_card: ContextCard;
      name: string;
      calories: number; // 展示用四舍五入后的量级（食物=摄入，运动=消耗）
      snapshot: DeleteSnapshot;
      // 仅食物有：删除后受影响的餐卡定位信息，调用方据此决定何时 refreshMealCard
      mealInfo?: { mealDate: string; meal_type: MealType };
    }
  | { ok: false; reason: "not_found" };

export async function executeDelete(params: {
  user_id: string;
  kind: "food" | "exercise";
  record_id: string;
  // chat.ts 的 modify 流程已经统一写 ai_parse_log + 回填 reply_summary，直删场景 skipLog=true 避免 L0 重复；
  // 存量 pending delete_confirm 走 HTTP /pending/:id/resolve 或 resolve_pending 意图时沿用原 skipLog 语义
  skipLog?: boolean;
}): Promise<ExecuteDeleteResult> {
  const { user_id, kind, record_id, skipLog } = params;

  if (kind === "exercise") {
    const exRec = await prisma.exerciseRecord.findFirst({ where: { id: record_id, user_id } });
    if (!exRec) return { ok: false, reason: "not_found" };
    const recDate = exRec.date.toISOString().slice(0, 10);

    await prisma.exerciseRecord.deleteMany({ where: { id: record_id, user_id } });

    if (!skipLog) {
      const action: ResolveAction = { action: "delete_confirm", name: exRec.type, record_id, kind: "exercise" };
      await prisma.aiParseLog.create({ data: buildResolveLogData(user_id, action) });
    }
    await recompute(user_id, recDate);
    const summary_card = await buildContextCard(user_id);
    recordDeleteCorrection({ userId: user_id, recordId: record_id, kind: "exercise", name: exRec.type });

    const snapshot: DeleteExerciseSnapshot = {
      kind: "exercise",
      type: exRec.type,
      duration_min: exRec.duration_min,
      calories_burned: exRec.calories_burned,
      source: exRec.source,
      raw_input: exRec.raw_input,
      date: recDate,
    };
    return { ok: true, summary_card, name: exRec.type, calories: Math.round(exRec.calories_burned), snapshot };
  }

  const rec = await prisma.foodRecord.findFirst({ where: { id: record_id, user_id }, include: { food: true } });
  if (!rec) return { ok: false, reason: "not_found" };
  const recDate = rec.date.toISOString().slice(0, 10);

  // 学习信号（LEARNING_SPEC §3）：删除只记事件不训练。必须在 deleteMany 之前写入——
  // learning_event.food_record_id 有外键约束，记录一旦删除就无法再插入指向它的新行。
  await recordLearningEvent({
    user_id,
    food_record_id: rec.id,
    food_id: rec.food_id,
    category: rec.food.category,
    predicted_grams: rec.weight_g,
    final_grams: rec.weight_g,
    predicted_label: rec.portion_label,
    final_label: rec.portion_label,
    signal_type: "delete",
    scene: rec.scene,
  });

  const snapshot: DeleteFoodSnapshot = {
    kind: "food",
    food_id: rec.food_id,
    meal_type: rec.meal_type,
    portion_label: rec.portion_label,
    weight_g: rec.weight_g,
    calories: rec.calories,
    protein: rec.protein,
    fat: rec.fat,
    carbs: rec.carbs,
    food_confidence: rec.food_confidence,
    portion_confidence: rec.portion_confidence,
    source: rec.source,
    raw_input: rec.raw_input,
    alias_canonical: rec.alias_canonical,
    predicted_grams: rec.predicted_grams,
    scene: rec.scene,
    calories_source: rec.calories_source,
    date: recDate,
  };
  const name = rec.food.name;
  const calories = Math.round(rec.calories);

  await prisma.foodRecord.deleteMany({ where: { id: record_id, user_id } });

  if (!skipLog) {
    const action: ResolveAction = { action: "delete_confirm", name, record_id, kind: "food" };
    await prisma.aiParseLog.create({ data: buildResolveLogData(user_id, action) });
  }
  await recompute(user_id, recDate);
  const summary_card = await buildContextCard(user_id);
  recordDeleteCorrection({ userId: user_id, recordId: record_id, kind: "food", name });

  return {
    ok: true,
    summary_card,
    name,
    calories,
    snapshot,
    mealInfo: { mealDate: recDate, meal_type: rec.meal_type },
  };
}
