import { prisma } from "../../lib/prisma";
import { recompute, buildContextCard } from "../summary";
import { refreshMealCard } from "../meal-card";
import { processItems } from "./food-item";
import { calcExerciseCalories, resolveDuration } from "./exercise";
import { guessMealType, extractMealTypeFromText } from "../../lib/dates";
import type { MealType } from "@prisma/client";
import type { ParseResult } from "../../ai/schema";
import type { IntentCtx } from "./types";

// 续报口吻："还有X"、"另外吃了Y"、"再来一份Z"——是对刚才那餐的补充，不是独立加餐
const CONTINUATION_RE = /^(还有|还吃|还喝|还来|另外|再|也|顺便|以及|外加|加上)/;

// 续报餐次继承：无时间词、AI 也没给餐次时，若 30 分钟内刚记过一餐则跟随那一餐。
// 场景："中午吃了疙瘩汤"后接"还有粽子"，粽子应同属午餐，而不是按当前时间猜成加餐。
async function inheritRecentMealType(user_id: string): Promise<MealType | null> {
  const recent = await prisma.foodRecord.findFirst({
    where: { user_id, created_at: { gt: new Date(Date.now() - 30 * 60 * 1000) } },
    orderBy: { created_at: "desc" },
    select: { meal_type: true },
  });
  return recent?.meal_type ?? null;
}

export async function handleRecord(
  parsed: Extract<ParseResult, { intent: "record" }>,
  ctx: IntentCtx,
) {
  const { user_id, text, source, today, dateObj, messages, tctx, parseUsage, parseMessages } = ctx;

  const user = await prisma.user.findUniqueOrThrow({ where: { id: user_id } });
  const weight_kg = Number(user.weight_kg) || 70;
  let mealResolved = (extractMealTypeFromText(text) ?? parsed.meal_type) as MealType | undefined;
  if (!mealResolved && CONTINUATION_RE.test(text.trim())) {
    mealResolved = (await inheritRecentMealType(user_id)) ?? undefined;
  }
  const meal_type = (mealResolved ?? guessMealType()) as MealType;

  // Trace: 确定 meal_type 后写入 meal_id + state_snapshot
  await tctx.setMeal(meal_type);

  // 处理食物条目（逐条走共用 helper：歧义→候选卡 / 份量不明→份量卡 / 高置信→自动入库）
  const { records, replyParts, pending, needsRecompute: itemsNeedRecompute, pendingCreateFns } =
    await processItems(
      parsed.items ?? [],
      { user_id, meal_type, source, dateObj, scene: parsed.scene ?? "unknown" },
      (idx) => tctx.itemTrace(idx),
    );
  let needsRecompute = itemsNeedRecompute;
  const exerciseCreateFns: Array<() => Promise<any>> = [];

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
    exerciseCreateFns.push(() => prisma.chatMessage.create({ data: exData }));
  }

  // 按优先级写入：已确认先，待确认后
  for (const fn of [...exerciseCreateFns, ...pendingCreateFns]) {
    const msg = await fn();
    messages.push(msg);
  }

  // T46：本轮有食材入库 → 对该餐 upsert meal_card（一餐一卡，幂等）。
  // 放在其他消息之后创建/bump，保证卡片排在本轮回复末尾（卡片跟随）。
  // 明细/总计由 enrichMealCards 从 food_record 实时组装，不落库。
  let isFirstMealCard = false;
  if (records.length > 0) {
    const refreshed = await refreshMealCard(messages, {
      user_id, mealDate: today, meal_type, chatDate: dateObj,
    });
    isFirstMealCard = refreshed?.isFirst ?? false;
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
  // 首次引导（T46）：用户第一张 meal_card 生成时提示一次，之后不再出现（不常驻卡片上）
  if (isFirstMealCard) {
    replyText += "直接说就能修改、新增、删除食材。";
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
