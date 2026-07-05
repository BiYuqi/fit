import { prisma } from "../../lib/prisma";
import { matchFood, matchFoodExactOrEstimate } from "../matcher";
import { itemNutrition, scaleNutritionToCalories } from "../calc";
import { recompute, buildContextCard } from "../summary";
import { recordModifyCorrection } from "../trace";
import { recordLearningEvent, resetFoodAliasStreak, upsertFoodAlias } from "../learning";
import { processItems } from "./food-item";
import { refreshMealCard } from "../meal-card";
import { executeDelete } from "../delete-record";
import { guessMealType, toDateOnly } from "../../lib/dates";
import type { MealType, PortionLabel } from "@prisma/client";
import type { ParseResult } from "../../ai/schema";
import type { IntentCtx } from "./types";

const MEAL_ZH: Record<string, string> = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐" };

export async function handleModify(
  parsed: Extract<ParseResult, { intent: "modify" }>,
  ctx: IntentCtx,
) {
  const { user_id, text, source, today, dateObj, pack, messages, tctx, parseUsage, parseMessages } = ctx;

  // target 可为 ref 数组（批量改餐次"以上发的都是早餐"）；其余场景等价单条
  const refs = Array.isArray(parsed.target) ? parsed.target : [parsed.target];

  // ── 批量改餐次：多 target + update + change.meal_type → 一次改完，汇总一条回复 ──
  // （schema/prompt 约定数组只用于批量改餐次；其他批量组合不受支持，走下方单条逻辑取第一条）
  if (refs.length > 1 && parsed.action === "update" && parsed.change?.meal_type) {
    const newMeal = parsed.change.meal_type as MealType;
    const foodRefs = refs
      .map((ref) => pack.recent_records.find((r) => r.ref === ref))
      .filter((r): r is NonNullable<typeof r> => !!r && r.kind === "food");
    const recs = await prisma.foodRecord.findMany({
      where: { id: { in: foodRefs.map((r) => r.record_id) }, user_id },
      include: { food: true },
    });
    if (recs.length === 0) {
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "没找到要改餐次的那些记录，可以说得具体一点吗？" },
      });
      messages.push(aiMsg);
      const card = await buildContextCard(user_id);
      tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
      return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
    }

    await prisma.foodRecord.updateMany({
      where: { id: { in: recs.map((r) => r.id) }, user_id },
      data: { meal_type: newMeal },
    });
    await recompute(user_id, today);
    for (const rec of recs) {
      await recordModifyCorrection({
        traceId: tctx.traceId,
        recordId: rec.id,
        foodId: rec.food_id,
        foodName: rec.food.name,
        prevState: { meal_type: rec.meal_type },
        newState: { meal_type: newMeal },
        isFoodChange: false,
        modifyConfidence: (parsed as any).modify_confidence,
      });
    }
    const card = await buildContextCard(user_id);
    const content = `已把 ${recs.length} 条记录改为${MEAL_ZH[newMeal]}：${recs.map((r) => r.food.name).join("、")}。`;
    const aiMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "assistant", kind: "text", content },
    });
    messages.push(aiMsg);

    // T47 双卡刷新：旧餐次卡少一项（只 bump 已存在的，不给 pre-T46 的餐凭空造卡）、新餐次卡多一项。
    // 按 (餐归属日, 餐次) 去重；旧卡先 bump、新卡后 bump，新卡浮到最末。批量改无单条撤销，不动 last_change。
    const oldKeys = new Map<string, { mealDate: string; meal_type: MealType }>();
    const newKeys = new Map<string, { mealDate: string; meal_type: MealType }>();
    for (const rec of recs) {
      const mealDate = rec.date.toISOString().slice(0, 10);
      if (rec.meal_type !== newMeal) {
        oldKeys.set(`${mealDate}|${rec.meal_type}`, { mealDate, meal_type: rec.meal_type as MealType });
      }
      newKeys.set(`${mealDate}|${newMeal}`, { mealDate, meal_type: newMeal });
    }
    for (const k of oldKeys.values()) {
      await refreshMealCard(messages, {
        user_id, mealDate: k.mealDate, meal_type: k.meal_type,
        chatDate: toDateOnly(k.mealDate), createIfMissing: false,
      });
    }
    for (const k of newKeys.values()) {
      await refreshMealCard(messages, {
        user_id, mealDate: k.mealDate, meal_type: k.meal_type,
        chatDate: toDateOnly(k.mealDate),
      });
    }

    tctx.ok("modify", { mealType: newMeal, tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "modify", reply: content, summary_card: card, messages };
  }

  const target = pack.recent_records.find((r) => r.ref === refs[0]);
  if (!target) {
    const aiMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "没找到要修改的那条记录，可以说得具体一点吗？" },
    });
    messages.push(aiMsg);
    const card = await buildContextCard(user_id);
    tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages }); // trace 结束：status=partial（找不到 target）
    return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
  }

  // delete → 免确认直删 + 可撤销事件行（T49：不再走 pending 确认卡）
  if (parsed.action === "delete") {
    const result = await executeDelete({
      user_id,
      kind: target.kind === "exercise" ? "exercise" : "food",
      record_id: target.record_id,
      skipLog: true, // chat.ts 已为本轮统一写 ai_parse_log + 回填 reply_summary
    });
    if (!result.ok) {
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "这条记录好像已经不在了。" },
      });
      messages.push(aiMsg);
      const card = await buildContextCard(user_id);
      tctx.partial("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
      return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
    }
    const content = `已删除 ${result.name} · -${result.calories} kcal`;
    const eventMsg = await prisma.chatMessage.create({
      data: {
        user_id, date: dateObj, role: "assistant", kind: "event",
        payload: {
          event_type: "deleted", text: content, record_id: target.record_id,
          undo: { prev_state: result.snapshot }, undone: false,
        } as object,
      },
    });
    messages.push(eventMsg);
    // 卡片跟随：事件行先落，受影响餐卡（少一项）后 bump 浮到最末；只 bump 已存在的卡
    if (result.mealInfo) {
      await refreshMealCard(messages, {
        user_id, mealDate: result.mealInfo.mealDate, meal_type: result.mealInfo.meal_type,
        chatDate: dateObj, createIfMissing: false,
      });
    }
    tctx.ok("modify", { tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "modify", reply: content, summary_card: result.summary_card, messages };
  }

  // append → 在 target 所属餐追加新食物（继承 meal_type），高置信直入库 + 撤销
  if (parsed.action === "append") {
    const meal_type = (target.meal_type ?? guessMealType()) as MealType;
    await tctx.setMeal(meal_type); // trace: 关联 meal + 写入 state_snapshot

    const { records, replyParts, pending, needsRecompute, pendingCreateFns } =
      await processItems(
        parsed.items ?? [],
        { user_id, meal_type, source, dateObj },
        (idx) => tctx.itemTrace(idx),
      );

    for (const fn of pendingCreateFns) messages.push(await fn());
    if (needsRecompute) await recompute(user_id, today);

    // T47：追加并入该餐 meal_card 并 bump；last_change 无 prev_state = 撤销即删除（同 append undo 语义）
    if (records.length > 0) {
      await refreshMealCard(messages, {
        user_id, mealDate: today, meal_type, chatDate: dateObj,
        lastChange: { record_id: records[records.length - 1].id },
      });
    }
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

  const prev_state = {
    food_id: rec.food_id, portion_label: rec.portion_label, weight_g: rec.weight_g, meal_type: rec.meal_type,
    calories: rec.calories, protein: rec.protein, fat: rec.fat, carbs: rec.carbs, calories_source: rec.calories_source,
  };
  const change = parsed.change ?? {};
  let food = await prisma.foodStandard.findUniqueOrThrow({ where: { id: rec.food_id } });
  const originalFoodName = food.name; // T40 自愈闭环：属性修正后 alias 指回这个原名（下次同名食物直连命中修正版）
  let weight_g = rec.weight_g;
  let portion_label = rec.portion_label as PortionLabel;
  let meal_type = rec.meal_type as MealType;

  if (change.food) {
    food = await matchFood(change.food, undefined, user_id);   // 改食物：份量沿用旧的
  }
  if (change.food_desc) {
    // T40：属性修正（"无油"/"去皮"等）影响营养口径——构造具体变体名强制重估，不走弱匹配裁决
    // （否则 trgm 几乎必然召回原条目，复用旧营养值会让修正静默失效，见 matchFoodExactOrEstimate 注释）
    food = await matchFoodExactOrEstimate(`${food.name}（${change.food_desc}）`, text, user_id);
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
  // T40 自愈闭环（LEARNING_SPEC §6 §7）：属性修正产生的估算条目直连回原食物名，
  // 下次再说"葱花饼"，streak≥2 后直接命中无油版——修正一次终身受益。
  if (change.food_desc) {
    upsertFoodAlias(user_id, originalFoodName, food.id);
  }

  const baseNutrition = itemNutrition(food, weight_g);
  // T40：change.calories 是用户亲口给出的最终热量（用户真值），铁律 1 禁的是 AI 算账，不禁用户报数——
  // 直接采信，按比例回推宏量素；calories_source=user_override 防止后续同条记录被 food×grams 静默重算覆盖。
  const nutrition = change.calories != null ? scaleNutritionToCalories(baseNutrition, change.calories) : baseNutrition;
  const calories_source = change.calories != null ? "user_override" : "computed";

  const updated = await prisma.foodRecord.update({
    where: { id: rec.id },
    data: {
      food_id: food.id, portion_label, weight_g, meal_type,
      calories: nutrition.calories, protein: nutrition.protein_g,
      fat: nutrition.fat_g, carbs: nutrition.carbs_g,
      calories_source,
      alias_canonical: (change.food || change.food_desc) ? null : undefined,
    },
  });
  await recompute(user_id, today);
  const card = await buildContextCard(user_id);

  // T49：回执降级为居中事件行（带 delta），撤销走 meal_card 项级 last_change，事件行本身不带 undo
  const oldCal = Math.round(prev_state.calories);
  const newCal = Math.round(nutrition.calories);
  const delta = newCal - oldCal;
  const deltaStr = delta !== 0 ? `（${delta > 0 ? "+" : ""}${delta} kcal）` : "";
  let subject: string;
  if (change.food || change.food_desc) {
    subject = `${originalFoodName} → ${food.name}`;
  } else if (change.grams != null || change.portion_label) {
    subject = `${food.name} ${Math.round(prev_state.weight_g)}g → ${Math.round(weight_g)}g`;
  } else if (change.meal_type) {
    subject = `${food.name} 改到${MEAL_ZH[meal_type]}`;
  } else if (change.calories != null) {
    subject = `${food.name} 热量改为 ${newCal}kcal`;
  } else {
    subject = food.name;
  }
  const content = `已修改：${subject}${deltaStr}`;
  const aiMsg = await prisma.chatMessage.create({
    data: {
      user_id, date: dateObj, role: "assistant", kind: "event",
      payload: { event_type: "modified", text: content, record_id: updated.id, undone: false } as object,
    },
  });
  messages.push(aiMsg);

  // 修改走原地刷新该餐 meal_card。改餐次是双卡刷新：
  // 旧餐卡少一项（只 bump 已存在的），新餐卡多一项；撤销信息写进目标餐卡 last_change
  // （单槽：再次修改覆盖，撤销后由 undo 接口清除）。跨天修改刷的是记录归属日那张卡。
  const mealDate = rec.date.toISOString().slice(0, 10);
  if (meal_type !== prev_state.meal_type) {
    await refreshMealCard(messages, {
      user_id, mealDate, meal_type: prev_state.meal_type as MealType,
      chatDate: toDateOnly(mealDate), createIfMissing: false,
    });
  }
  await refreshMealCard(messages, {
    user_id, mealDate, meal_type, chatDate: toDateOnly(mealDate),
    lastChange: { record_id: updated.id, prev_state }, // 撤销=还原 prev_state
  });
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
  // 学习信号（T40）：热量/属性修正只记档不训练克数偏差模型（predicted==final_grams，权重0）
  if (change.calories != null) {
    recordLearningEvent({
      user_id,
      food_record_id: updated.id,
      food_id: food.id,
      category: food.category,
      predicted_grams: weight_g,
      final_grams: weight_g,
      predicted_label: portion_label,
      final_label: portion_label,
      signal_type: "calorie_override",
      scene: rec.scene,
    });
  }
  if (change.food_desc != null) {
    recordLearningEvent({
      user_id,
      food_record_id: updated.id,
      food_id: food.id,
      category: food.category,
      predicted_grams: weight_g,
      final_grams: weight_g,
      predicted_label: portion_label,
      final_label: portion_label,
      signal_type: "food_desc_correction",
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
    newState: { food_name: food.name, food_id: food.id, portion_label, weight_g, calories: Math.round(nutrition.calories), calories_source },
    isFoodChange: !!(change.food || change.food_desc),
    modifyConfidence: (parsed as any).modify_confidence,
  });
  tctx.ok("modify", { tokenUsage: parseUsage });
  return { intent: "modify", reply: content, record: updated, summary_card: card, messages };
}
