import { prisma } from "../../lib/prisma";
import { recompute, buildContextCard } from "../summary";
import { processItems } from "./food-item";
import { calcExerciseCalories, resolveDuration } from "./exercise";
import { guessMealType, extractMealTypeFromText } from "../../lib/dates";
import type { MealType } from "@prisma/client";
import type { ParseResult } from "../../ai/schema";
import type { IntentCtx } from "./types";

export async function handleRecord(
  parsed: Extract<ParseResult, { intent: "record" }>,
  ctx: IntentCtx,
) {
  const { user_id, text, source, today, dateObj, messages, tctx, parseUsage, parseMessages } = ctx;

  const user = await prisma.user.findUniqueOrThrow({ where: { id: user_id } });
  const weight_kg = Number(user.weight_kg) || 70;
  const meal_type = (extractMealTypeFromText(text) ?? parsed.meal_type ?? guessMealType()) as MealType;

  // Trace: 确定 meal_type 后写入 meal_id + state_snapshot
  await tctx.setMeal(meal_type);

  // 处理食物条目（逐条走共用 helper：歧义→候选卡 / 份量不明→份量卡 / 高置信→自动入库）
  const { records, replyParts, pending, needsRecompute: itemsNeedRecompute, confirmedCreateFns, pendingCreateFns } =
    await processItems(
      parsed.items ?? [],
      { user_id, meal_type, source, dateObj, withUndo: false },
      (idx) => tctx.itemTrace(idx),
    );
  let needsRecompute = itemsNeedRecompute;

  // 处理运动条目（运动视为已确认）
  for (const ex of (parsed.exercise ?? [])) {
    // 次数型运动按 ~4s/次 估算时长，至少 1min
    const duration_min = resolveDuration(ex);
    const calories_burned = calcExerciseCalories(ex.type, duration_min, weight_kg);

    const exRecord = await prisma.exerciseRecord.create({
      data: {
        user_id,
        type: ex.type,
        duration_min,
        calories_burned,
        source,
        raw_input: text,
        date: dateObj,
      },
    });
    needsRecompute = true;
    const detail = ex.reps ? `${ex.reps}次 ≈ ${duration_min}min` : `${duration_min}min`;
    replyParts.push(`运动 ${ex.type} ${detail}（消耗约 ${calories_burned} kcal）`);

    const exData = {
      user_id,
      date: dateObj,
      role: "assistant" as const,
      kind: "exercise_card",
      payload: { exercise_id: exRecord.id, type: ex.type, duration_min, calories_burned } as object,
    };
    confirmedCreateFns.push(() => prisma.chatMessage.create({ data: exData }));
  }

  // 按优先级写入：已确认先，待确认后
  for (const fn of [...confirmedCreateFns, ...pendingCreateFns]) {
    const msg = await fn();
    messages.push(msg);
  }

  if (needsRecompute) await recompute(user_id, today);
  const summary_card = await buildContextCard(user_id);

  // 组织回复文本
  let replyText: string;
  if (records.length > 0 && !pending) {
    replyText = `已记录：${replyParts.join("，")}。今日摄入 ${summary_card.today.in} kcal，还可吃 ${summary_card.today.remaining} kcal。`;
  } else if (records.length > 0) {
    replyText = `部分已记录：${replyParts.join("，")}，还有内容需要确认。`;
  } else if (pending) {
    replyText = "请帮我确认一下具体信息。";
  } else {
    replyText = "已记录。";
  }

  // Trace 结束：status=ok，所有 item 的 event 已在 processFoodItem 内写入
  tctx.ok("record", { mealType: meal_type, tokenUsage: parseUsage, promptMessages: parseMessages });
  return {
    intent: "record",
    reply: replyText,
    record: records.length === 1 ? records[0] : records.length > 1 ? records[0] : undefined,
    records: records.length > 0 ? records : undefined,
    pending: pending ?? undefined,
    summary_card,
    messages,
  };
}
