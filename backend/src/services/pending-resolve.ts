// pending_record 核心 resolve 逻辑（T38 从 routes/pending.ts 抽出）。
// 抽成纯服务函数，让卡片点选（HTTP /pending/:id/resolve）与文字回答（chat.ts intents/resolve-pending）
// 共用同一套落地逻辑，不重复维护两份（也保住 status=pending 的原子防线：查不到就是没得 resolve）。
import { prisma } from "../lib/prisma";
import { todayStr, toDateOnly, guessMealType } from "../lib/dates";
import { matchFood } from "./matcher";
import { itemNutrition } from "./calc";
import { recompute, buildContextCard, type ContextCard } from "./summary";
import { recordResolveCorrection } from "./trace";
import { recordLearningEvent, upsertFoodAlias, getBiases, applyBias, biasEnabled } from "./learning";
import { refreshMealCard } from "./meal-card";
import { executeDelete } from "./delete-record";
import { buildResolveLogData, type ResolveAction } from "./resolve-log";
import type { MealType, PortionLabel, FoodRecord, ChatMessage } from "@prisma/client";

// 前端卡片过期口径（portion-card.tsx / candidate-card.tsx 的 STALE_MS）保持一致
export const PENDING_STALE_MS = 5 * 60 * 1000;

export type ResolveChoice = string | { grams: number };

export type ResolveOutcome =
  | { ok: true; record?: FoodRecord; summary_card: ContextCard; messages: ChatMessage[]; action: ResolveAction }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_food" };

export async function resolvePendingRecord(params: {
  user_id: string;
  pendingId: string;
  choice: ResolveChoice;
  // T38：chat.ts 文字回答路径已经有外层 ai_parse_log（intent=resolve_pending）承载本轮，
  // 传 true 跳过这里的内部落 log，避免同一轮对话在 L0 里出现两条重复记录。
  // 调用方随后应把 outcome.action 写回自己那条日志（见 intents/resolve-pending.ts）。
  skipLog?: boolean;
}): Promise<ResolveOutcome> {
  const { user_id, pendingId: id, choice, skipLog } = params;

  const pr = await prisma.pendingRecord.findFirst({
    where: { id, user_id, status: "pending" },
  });
  if (!pr) return { ok: false, reason: "not_found" };

  const candidates = pr.candidates as any;
  const today = todayStr();
  const dateObj = toDateOnly(today);
  const meal_type = (candidates.meal_type ?? guessMealType()) as MealType;
  const source: string = candidates.source ?? "text";

  // delete_confirm：存量兼容——T49 起新增删除不再走 pending 流程（见 modify.ts 直删 + executeDelete），
  // 这个分支只为历史上未 resolve 的卡片保留。不额外创建 event/text 消息——前端的
  // delete_confirm_card 本身在 resolved 后会显示"已删除「xxx」"。
  if (pr.type === "delete_confirm") {
    const result = await executeDelete({
      user_id,
      kind: (candidates.kind as "food" | "exercise") ?? "food",
      record_id: candidates.record_id,
      skipLog,
    });
    await prisma.pendingRecord.update({ where: { id }, data: { status: "resolved" } });

    const action: ResolveAction = {
      action: "delete_confirm",
      name: candidates.name,
      record_id: candidates.record_id,
      kind: candidates.kind ?? "food",
    };

    if (!result.ok) {
      // 记录在存量 pending 卡片等待期间已被别的路径删掉——直接返回当前状态，不重复处理
      const summary_card = await buildContextCard(user_id);
      return { ok: true, summary_card, messages: [], action };
    }

    // T47：食物删除后原地刷新该餐 meal_card（items 减一并 bump；全删光 → items:[] 已清空态）。
    // 只 bump 已存在的卡（pre-T46 记录没有卡就不造）；运动删除不涉及餐卡。
    const messages: ChatMessage[] = [];
    if (result.mealInfo) {
      await refreshMealCard(messages, {
        user_id,
        mealDate: result.mealInfo.mealDate,
        meal_type: result.mealInfo.meal_type,
        chatDate: toDateOnly(result.mealInfo.mealDate),
        createIfMissing: false,
      });
    }
    return { ok: true, summary_card: result.summary_card, messages, action };
  }

  let food_id: string;
  let weight_g: number;
  let portion_label: PortionLabel;
  let resolved_unit = "g";
  // 学习信号（LEARNING_SPEC §3）：AI 原估份量 vs 用户最终选择
  let predictedGrams: number | undefined;
  let predictedLabel: string | undefined;
  let learningSignal: "custom_gram" | "card_choice" | undefined;

  if (pr.type === "portion_choice") {
    food_id = candidates.food_id as string;
    const portions: Array<{ label: string; grams: number; unit?: string }> = candidates.portions ?? [];
    const predictedPortion = portions.find((p) => p.label === candidates.chosen_label)
      ?? portions.find((p) => p.label === "medium")
      ?? portions[0];
    // T31 起 candidates.portions 是偏差修正后的克数；学习基准（predicted）用建卡时存的 AI 原估
    predictedGrams = candidates.predicted_grams ?? predictedPortion?.grams;
    predictedLabel = predictedPortion?.label ?? candidates.chosen_label;

    if (typeof choice === "object" && "grams" in choice) {
      weight_g = choice.grams;
      portion_label = "custom";
      learningSignal = "custom_gram";
    } else {
      const chosen = portions.find((p) => p.label === choice) ?? portions.find((p) => p.label === "medium") ?? portions[0];
      weight_g = chosen?.grams ?? 150;
      portion_label = (chosen?.label ?? "medium") as PortionLabel;
      resolved_unit = chosen?.unit ?? "g";
      learningSignal = "card_choice";
    }
  } else {
    // food_choice：choice 是食物名（string），用 matchFood 查找/估算
    // 不直接落库，而是生成 portion_choice pending → 返回 PortionCard（两步走）
    const foodName = choice as string;
    const food = await matchFood(foodName, undefined, user_id);

    // 学习信号（LEARNING_SPEC §6）：用户在候选卡选定了食物，记进用户食物直连表
    const aliasCanonical = candidates.query as string | undefined;
    if (aliasCanonical) {
      upsertFoodAlias(user_id, aliasCanonical, food.id);
    }

    // 份量偏差（LEARNING_SPEC §5，T31）：候选卡阶段食物未知没法修正，
    // 此刻食物已定 → 对各档克数应用偏差；predicted_grams 保留 AI 原估作学习基准
    const portionsList: Array<{ label: string; grams: number }> = candidates.portions ?? [];
    const rawChosen = portionsList.find((p) => p.label === candidates.chosen_label)
      ?? portionsList.find((p) => p.label === "medium")
      ?? portionsList[0];
    const biases = biasEnabled() ? await getBiases(user_id, food.id, food.category, candidates.scene) : {};
    const portionsWithCal = portionsList.map((p) => {
      const grams = applyBias(p.grams, biases);
      return {
        ...p,
        grams,
        calories: grams > 0 ? Math.round(Number(food.calories_100g) * grams / 100) : undefined,
      };
    });
    const appliedChosen = portionsWithCal.find((p) => p.label === (rawChosen?.label ?? "medium"));

    const newPr = await prisma.pendingRecord.create({
      data: {
        user_id,
        type: "portion_choice",
        raw_input: pr.raw_input,
        candidates: {
          food_id: food.id,
          food_name: food.name,
          meal_type,
          source,
          portions: portionsWithCal,
          chosen_label: candidates.chosen_label,
          predicted_grams: rawChosen?.grams,
          applied_grams: appliedChosen?.grams,
          scene: candidates.scene ?? null,
          count: candidates.count ?? null,
          count_unit: candidates.count != null ? (candidates.count_unit ?? null) : null,
        } as object,
      },
    });

    await prisma.pendingRecord.update({ where: { id }, data: { status: "resolved" } });

    const action: ResolveAction = { action: "food_choice", food_name: food.name };
    // T37：候选卡选定食物进 L0——即使还没落库，下一轮"再来一份"也知道指的是它
    if (!skipLog) {
      await prisma.aiParseLog.create({ data: buildResolveLogData(user_id, action) });
    }

    const portionCardMsg = await prisma.chatMessage.create({
      data: {
        user_id,
        date: dateObj,
        role: "assistant",
        kind: "portion_card",
        payload: {
          pending_id: newPr.id,
          food_name: food.name,
          portions: portionsWithCal,
        } as object,
      },
    });

    const summary_card = await buildContextCard(user_id);
    return { ok: true, summary_card, messages: [portionCardMsg], action };
  }

  const food = await prisma.foodStandard.findUnique({ where: { id: food_id } });
  if (!food) return { ok: false, reason: "invalid_food" };

  const nutrition = itemNutrition(food, weight_g);

  const record = await prisma.foodRecord.create({
    data: {
      user_id,
      food_id: food.id,
      meal_type,
      portion_label,
      weight_g,
      calories: nutrition.calories,
      protein: nutrition.protein_g,
      fat: nutrition.fat_g,
      carbs: nutrition.carbs_g,
      source,
      raw_input: pr.raw_input,
      date: dateObj,
      predicted_grams: predictedGrams ?? null,
      scene: candidates.scene ?? null,
      count: candidates.count ?? null,
      count_unit: candidates.count != null ? (candidates.count_unit ?? null) : null,
    },
  });

  // Store resolution in candidates so read endpoints can enrich card payloads
  const resolvedCandidates = {
    ...(candidates as object),
    resolved_portion: portion_label,
    resolved_grams: weight_g,
    resolved_unit,
  };
  await prisma.pendingRecord.update({
    where: { id },
    data: { status: "resolved", candidates: resolvedCandidates as object },
  });

  const action: ResolveAction = {
    action: "portion_choice",
    food_name: food.name,
    portion_label,
    grams: weight_g,
  };
  // T37：份量确认进 L0，成为一轮完整对话（parsed_json 带食物锚点供指代）
  if (!skipLog) {
    await prisma.aiParseLog.create({ data: buildResolveLogData(user_id, action) });
  }

  // 学习信号（LEARNING_SPEC §3）：predicted = AI 原估（chosen_label 档），final = 用户实选
  if (predictedGrams != null && learningSignal) {
    recordLearningEvent({
      user_id,
      food_record_id: record.id,
      food_id: food.id,
      category: food.category,
      predicted_grams: predictedGrams,
      applied_grams: candidates.applied_grams ?? predictedGrams,
      final_grams: weight_g,
      predicted_label: predictedLabel ?? null,
      final_label: portion_label,
      signal_type: learningSignal,
      scene: candidates.scene ?? null,
    });
  }

  // Trace: correction event（用户从 portion_card / candidate_card 选择了具体份量或食物）
  recordResolveCorrection({
    userId: user_id,
    foodName: food.name,
    foodId: food.id,
    portionLabel: portion_label,
    weightG: weight_g,
    pendingId: id,
    pendingType: pr.type,
    candidates: candidates as Record<string, unknown>,
  });

  await recompute(user_id, today);
  const summary_card = await buildContextCard(user_id);

  // 份量确认不再产文本回执（T49 降噪同类，当时漏掉此 case）：meal_card 原地 upsert 就是"已录入"的视觉反馈，
  // 用户刚亲手选的份量、无撤销诉求，再发一条「已确认：…」全气泡纯属噪音。聊天流只余刷新后的该餐卡。
  const messages: ChatMessage[] = [];
  await refreshMealCard(messages, { user_id, mealDate: today, meal_type, chatDate: dateObj });

  return { ok: true, record, summary_card, messages, action };
}
