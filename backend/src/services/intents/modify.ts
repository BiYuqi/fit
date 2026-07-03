import { prisma } from "../../lib/prisma";
import { matchFood } from "../matcher";
import { itemNutrition } from "../calc";
import { recompute, buildContextCard } from "../summary";
import { recordModifyCorrection } from "../trace";
import { recordLearningEvent, resetFoodAliasStreak } from "../learning";
import { processItems } from "./food-item";
import { guessMealType } from "../../lib/dates";
import type { MealType, PortionLabel } from "@prisma/client";
import type { ParseResult } from "../../ai/schema";
import type { IntentCtx } from "./types";

export async function handleModify(
  parsed: Extract<ParseResult, { intent: "modify" }>,
  ctx: IntentCtx,
) {
  const { user_id, text, source, today, dateObj, pack, messages, tctx, parseUsage, parseMessages } = ctx;

  const target = pack.recent_records.find((r) => r.ref === parsed.target);
  if (!target) {
    const aiMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "没找到要修改的那条记录，可以说得具体一点吗？" },
    });
    messages.push(aiMsg);
    const card = await buildContextCard(user_id);
    tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages }); // trace 结束：status=partial（找不到 target）
    return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
  }

  // delete → 确认卡（破坏性，需确认）
  if (parsed.action === "delete") {
    const pr = await prisma.pendingRecord.create({
      data: {
        user_id, type: "delete_confirm", raw_input: text,
        candidates: { record_id: target.record_id, kind: target.kind, name: target.name } as object,
      },
    });
    const aiMsg = await prisma.chatMessage.create({
      data: {
        user_id, date: dateObj, role: "assistant", kind: "delete_confirm_card",
        payload: { pending_id: pr.id, record_id: target.record_id, name: target.name, meal_type: target.meal_type, calories: target.calories } as object,
      },
    });
    messages.push(aiMsg);
    const card = await buildContextCard(user_id);
    tctx.ok("modify", { tokenUsage: parseUsage, promptMessages: parseMessages }); // trace 结束（correction 在用户确认时由 resolve 写）
    return { intent: "modify", reply: `确认删除「${target.name}」吗？`, pending: pr, summary_card: card, messages };
  }

  // append → 在 target 所属餐追加新食物（继承 meal_type），高置信直入库 + 撤销
  if (parsed.action === "append") {
    const meal_type = (target.meal_type ?? guessMealType()) as MealType;
    await tctx.setMeal(meal_type); // trace: 关联 meal + 写入 state_snapshot

    const { records, replyParts, pending, needsRecompute, confirmedCreateFns, pendingCreateFns } =
      await processItems(
        parsed.items ?? [],
        { user_id, meal_type, source, dateObj, withUndo: true },
        (idx) => tctx.itemTrace(idx),
      );

    for (const fn of [...confirmedCreateFns, ...pendingCreateFns]) messages.push(await fn());
    if (needsRecompute) await recompute(user_id, today);
    const card = await buildContextCard(user_id);
    const reply = records.length > 0
      ? `已追加：${replyParts.join("，")}。`
      : pending ? "请帮我确认追加内容。" : "好的。";
    tctx.ok("modify", { mealType: meal_type, tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "modify", reply, records: records.length ? records : undefined, pending: pending ?? undefined, summary_card: card, messages };
  }

  // update → 改份量 / 改食物 / 改运动消耗，高置信直改 + 重算 + 撤销

  // ── 运动记录更新 ──
  if (target.kind === "exercise") {
    const exRec = await prisma.exerciseRecord.findFirst({ where: { id: target.record_id, user_id } });
    if (!exRec) {
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "这条运动记录好像已经不在了。" },
      });
      messages.push(aiMsg);
      const card = await buildContextCard(user_id);
      return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
    }

    const change = parsed.change ?? {};
    if (!change.calories_burned) {
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: '请告诉我新的消耗热量是多少？比如「改成 400 千卡」。', },
      });
      messages.push(aiMsg);
      const card = await buildContextCard(user_id);
      return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
    }

    const prev_calories = exRec.calories_burned;
    const updated = await prisma.exerciseRecord.update({
      where: { id: exRec.id },
      data: { calories_burned: change.calories_burned },
    });
    await recompute(user_id, today);
    const card = await buildContextCard(user_id);
    const content = `已更新：${exRec.type} 消耗 ${Math.round(change.calories_burned)} kcal（原估算 ${Math.round(prev_calories)} kcal）`;
    const aiMsg = await prisma.chatMessage.create({
      data: {
        user_id, date: dateObj, role: "assistant", kind: "exercise_card", content,
        payload: {
          exercise_id: updated.id, type: exRec.type, duration_min: exRec.duration_min,
          calories_burned: change.calories_burned,
          undo: { record_id: updated.id, prev_state: { calories_burned: prev_calories, kind: "exercise" as const } },
        } as object,
        record_id: updated.id as string,
      },
    });
    messages.push(aiMsg);
    tctx.ok("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "modify", reply: content, summary_card: card, messages };
  }

  // ── 食物记录更新 ──
  const rec = await prisma.foodRecord.findFirst({ where: { id: target.record_id, user_id } });
  if (!rec) {
    const aiMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "这条记录好像已经不在了。" },
    });
    messages.push(aiMsg);
    const card = await buildContextCard(user_id);
    return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
  }

  const prev_state = { food_id: rec.food_id, portion_label: rec.portion_label, weight_g: rec.weight_g, meal_type: rec.meal_type };
  const change = parsed.change ?? {};
  let food = await prisma.foodStandard.findUniqueOrThrow({ where: { id: rec.food_id } });
  let weight_g = rec.weight_g;
  let portion_label = rec.portion_label as PortionLabel;
  let meal_type = rec.meal_type as MealType;

  if (change.food) {
    food = await matchFood(change.food, undefined, user_id);   // 改食物：份量沿用旧的
  }
  if (change.meal_type) {
    meal_type = change.meal_type as MealType;                  // 改餐次（"粽子是中午吃的"）：数值不动
  }
  if (change.portion_label) {
    portion_label = change.portion_label as PortionLabel;
    if (change.grams) weight_g = change.grams;
  } else if (change.grams) {
    weight_g = change.grams;
    portion_label = "custom";
  }

  // 学习信号（LEARNING_SPEC §7）：改食物覆盖了用户食物直连自动匹配的结果 → 清零该 alias 的 streak，
  // 且这条记录不再代表"按习惯匹配"，清掉标记（同「不是它？」逃生口，只是触发方式是 modify 而非按钮）
  if (change.food && rec.alias_canonical) {
    resetFoodAliasStreak(user_id, rec.alias_canonical);
  }

  const nutrition = itemNutrition(food, weight_g);
  const updated = await prisma.foodRecord.update({
    where: { id: rec.id },
    data: {
      food_id: food.id, portion_label, weight_g, meal_type,
      calories: nutrition.calories, protein: nutrition.protein_g,
      fat: nutrition.fat_g, carbs: nutrition.carbs_g,
      alias_canonical: change.food ? null : undefined,
    },
  });
  await recompute(user_id, today);
  const card = await buildContextCard(user_id);
  const content = `已更新：${food.name} ${Math.round(weight_g)}g（约 ${Math.round(nutrition.calories)} kcal）`;
  const aiMsg = await prisma.chatMessage.create({
    data: {
      user_id, date: dateObj, role: "assistant", kind: "record_card", content,
      payload: {
        food_name: food.name, weight_g: Math.round(weight_g), calories: Math.round(nutrition.calories),
        protein_g: Math.round(nutrition.protein_g), fat_g: Math.round(nutrition.fat_g),
        carbs_g: Math.round(nutrition.carbs_g), is_estimated: food.is_estimated,
        meal_type,
        undo: { record_id: updated.id, prev_state }, // 撤销=还原 prev_state
      } as object,
      record_id: updated.id as string,
    },
  });
  messages.push(aiMsg);
  // 学习信号（LEARNING_SPEC §3）：predicted = 改前克数，final = 用户指定克数。
  // 只有 change.grams 时才是"克数纠正"——改食物（change.food）份量沿用旧的，不算纠正。
  if (change.grams != null) {
    recordLearningEvent({
      user_id,
      food_record_id: updated.id,
      food_id: food.id,
      category: food.category,
      predicted_grams: prev_state.weight_g,
      final_grams: weight_g,
      predicted_label: prev_state.portion_label,
      final_label: portion_label,
      signal_type: "explicit_gram",
      scene: rec.scene,
    });
  }
  // Trace: correction event（modify update——用户主动修改了 AI 的记录）
  await recordModifyCorrection({
    traceId: tctx.traceId,
    recordId: rec.id,
    foodId: rec.food_id,
    foodName: food.name,
    prevState: prev_state,
    newState: { food_name: food.name, food_id: food.id, portion_label, weight_g, calories: Math.round(nutrition.calories) },
    isFoodChange: !!change.food,
    modifyConfidence: (parsed as any).modify_confidence,
  });
  tctx.ok("modify", { tokenUsage: parseUsage });
  return { intent: "modify", reply: content, record: updated, summary_card: card, messages };
}
