import { prisma } from "../../lib/prisma";
import { recompute, buildContextCard } from "../summary";
import { refreshMealCard } from "../meal-card";
import { processItems } from "./food-item";
import { resolveDuration, resolveExerciseCalories } from "./exercise";
import { guessMealType, extractMealTypeFromText, extractDateOffsetFromText, addOffsetDays, dateOnlyStr } from "../../lib/dates";
import { extractExplicitSignals, hasMealAmbiguity } from "../explicit-signals";
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

  // 补记跨天（T62）：文本里的相对日期词（"昨天/前天"）优先于 AI 的 date_offset，
  // 同 extractMealTypeFromText 的既有模式——确定性正则比模型判断更可靠。
  // recordDate 是食物/运动真正归属的自然日；dateObj（发消息当天）继续只用于 chat_message（铁律3，聊天气泡不跟着记录倒退）。
  const dateOffset = extractDateOffsetFromText(text) ?? parsed.date_offset ?? 0;
  const recordDateObj = dateOffset !== 0 ? addOffsetDays(dateObj, dateOffset) : dateObj;
  const recordDateStr = dateOffset !== 0 ? dateOnlyStr(recordDateObj) : today;
  // 餐次判定（record 级默认值，item 级覆盖见下）：文本单信号时间词 > 多信号歧义时的 AI 判断 > 续报继承 > 当前时间。
  // 刻意不信零信号场景下 AI 的 parsed.meal_type：模型常无视"无时间词就省略餐次"的指令，
  // 看到上下文卡里某餐已有几项，就把新食物也脑补进那餐（如 12 点多记血桃被塞进早餐）。
  // 但多个时段词同现是"有信号但需消歧"（"早晨的饼 晚上又吃了"），这属于语言理解，正则做不了、
  // extractMealTypeFromText 此时会返回 null 承认歧义（T68），只有这一种情形才采信 AI（真机案例：
  // 2026-07-13 用户投诉"你记录错误，是晚上吃的啊"——AI 判对了却被正则第一个命中覆盖成错的）。
  let mealResolved = extractMealTypeFromText(text) as MealType | null;
  if (!mealResolved && hasMealAmbiguity(extractExplicitSignals(text))) {
    mealResolved = parsed.meal_type ?? null;
  }
  if (!mealResolved && CONTINUATION_RE.test(text.trim())) {
    mealResolved = (await inheritRecentMealType(user_id)) ?? null;
  }
  const meal_type = (mealResolved ?? guessMealType()) as MealType;

  // Trace: 确定 meal_type 后写入 meal_id + state_snapshot
  await tctx.setMeal(meal_type);

  // 处理食物条目（逐条走共用 helper：歧义→候选卡 / 份量不明→份量卡 / 高置信→自动入库）
  const { records, replyParts, pending, needsRecompute: itemsNeedRecompute, pendingCreateFns } =
    await processItems(
      parsed.items ?? [],
      { user_id, meal_type, source, dateObj, recordDate: recordDateObj, scene: parsed.scene ?? "unknown" },
      (idx) => tctx.itemTrace(idx),
    );
  let needsRecompute = itemsNeedRecompute;
  const exerciseCreateFns: Array<() => Promise<any>> = [];

  // 处理运动条目（运动视为已确认）
  for (const ex of (parsed.exercise ?? [])) {
    // 次数型运动按 ~4s/次 估算时长，至少 1min
    const duration_min = resolveDuration(ex);
    const { calories_burned, user_reported } = resolveExerciseCalories(ex, duration_min, weight_kg);

    const exRecord = await prisma.exerciseRecord.create({
      data: {
        user_id,
        type: ex.type,
        duration_min,
        calories_burned,
        user_reported, // T73：modify 改时长时据此决定重算 vs 沿用（用户真值不被 MET 覆盖）
        source,
        raw_input: text,
        date: recordDateObj,
      },
    });
    needsRecompute = true;
    const detail = ex.reps ? `${ex.reps}次 ≈ ${duration_min}min` : `${duration_min}min`;
    // 用户自报消耗是真值，不加"约"；MET 估算才是"约"
    const burnedText = user_reported ? `消耗 ${calories_burned} kcal` : `消耗约 ${calories_burned} kcal`;
    replyParts.push(`运动 ${ex.type} ${detail}（${burnedText}）`);

    const exData = {
      user_id,
      date: dateObj,
      role: "assistant" as const,
      kind: "exercise_card",
      payload: { exercise_id: exRecord.id, type: ex.type, duration_min, calories_burned, user_reported } as object,
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
  // T68：items 可能各自归到不同 (归属日, 餐次)（item 级 meal_type/date_offset），
  // 不能只按 record 级默认值刷一张卡——按每条落库记录的实际 (date, meal_type) 去重后逐个刷新。
  let isFirstMealCard = false;
  if (records.length > 0) {
    const mealKeys = new Map<string, { mealDate: string; meal_type: MealType }>();
    for (const r of records) {
      const mealDate = dateOnlyStr(r.date);
      mealKeys.set(`${mealDate}|${r.meal_type}`, { mealDate, meal_type: r.meal_type });
    }
    for (const { mealDate, meal_type: mt } of mealKeys.values()) {
      const refreshed = await refreshMealCard(messages, {
        user_id, mealDate, meal_type: mt, chatDate: dateObj,
      });
      if (refreshed?.isFirst) isFirstMealCard = true;
    }
  }

  if (needsRecompute) await recompute(user_id, recordDateStr);
  const summary_card = await buildContextCard(user_id);

  // 组织回复文本。补记到别的自然日时（dateOffset!=0）明确带出日期，
  // 不提"今日摄入"——那是当天的数，跟这条补记的归属日无关，混着说会让人以为记错了天（T62 教训）。
  let replyText: string;
  if (records.length > 0 && !pending) {
    replyText = dateOffset !== 0
      ? `已记录到 ${recordDateStr}：${replyParts.join("，")}。`
      : `已记录：${replyParts.join("，")}。今日摄入 ${summary_card.today.in} kcal，还可吃 ${summary_card.today.remaining} kcal。`;
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
