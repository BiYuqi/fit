import { matchFood, matchFoodCandidates } from "../matcher";
import { itemNutrition } from "../calc";
import { prisma } from "../../lib/prisma";
import { getFoodAlias, getBiases, applyBias, biasEnabled } from "../learning";
import type { FoodItem } from "../../ai/schema";
import type { FoodStandard, MealType, PortionLabel, PendingRecord } from "@prisma/client";
import type { ItemTrace } from "../trace";

// ---------- 单条食物处理（record 与 modify.append 共用） ----------
// 歧义判定双信号：AI is_ambiguous OR DB calorie_spread > 100 kcal/100g
const FOOD_AMBIGUITY_SPREAD = 100; // kcal/100g 离散度阈值

// ── trace helper：从 matchFoodCandidates 返回值推断匹配路径 ──
// matchFood 本身不返回 match_path，需要根据 dbCandidates 和 food 的属性推断。
export function inferMatchPath(
  food: { id: string; name: string; is_estimated: boolean },
  query: string,
  dbCandidates: Array<{ id: string; name: string }>,
): string {
  // AI 硬估（库里无匹配）
  if (food.is_estimated) return "ai_estimate";
  // AI 裁决（有候选但未精确命中，由 AI 从候选中选择）
  if ((food as any)._adjudicated) return "ai_adjudicate";
  // 精确匹配
  if (dbCandidates.length === 1 && dbCandidates[0].id === food.id) {
    if (dbCandidates[0].name === query) return "exact_name";
    if ((dbCandidates[0] as any)._aliasMatch) return "alias";
    return "prefix_true_spec";
  }
  // 模糊匹配（多个候选，trgm 命中了某个）
  if (dbCandidates.length > 1) return "pg_trgm";
  return "matched";
}

// ---------- 候选卡数据构建（歧义判定命中 / 用户点「不是它？」重发时共用） ----------
export interface CandidateCardData {
  pendingRecord: PendingRecord;
  foodsPayload: Array<{ name: string; calorie_hint?: number }>;
}

export async function buildCandidateCardData(params: {
  user_id: string;
  query: string;
  raw: string;
  meal_type: MealType;
  source: string;
  portions: FoodItem["portions"];
  chosen_label: PortionLabel;
  ai_candidates?: string[];
  scene?: string | null;
  count?: number | null;
  count_unit?: string | null;
}): Promise<CandidateCardData> {
  const { user_id, query, raw, meal_type, source, portions, chosen_label, ai_candidates, scene, count, count_unit } = params;
  const { foods: dbCandidates } = await matchFoodCandidates(query);

  const mediumGrams = (portions.find((p) => p.label === "medium") ?? portions[0])?.grams ?? 150;
  const dbNames = new Set(dbCandidates.map((f) => f.name));
  const aiNames: string[] = (ai_candidates ?? []).filter((n) => !dbNames.has(n));
  const allNames = [...dbCandidates.map((f) => f.name), ...aiNames].slice(0, 3);
  const foodsPayload = allNames.map((name) => {
    const dbEntry = dbCandidates.find((f) => f.name === name);
    return {
      name,
      calorie_hint: dbEntry ? Math.round(Number(dbEntry.calories_100g) * mediumGrams / 100) : undefined,
    };
  });

  const pendingRecord = await prisma.pendingRecord.create({
    data: {
      user_id, type: "food_choice", raw_input: raw,
      // candidate_names：T38 注入记忆包用，避免为了渲染【待确认】而重跑 matchFoodCandidates 或读 chat_message
      candidates: { query, meal_type, source, portions, chosen_label, scene: scene ?? null, candidate_names: allNames, count: count ?? null, count_unit: count != null ? (count_unit ?? null) : null } as object,
    },
  });

  return { pendingRecord, foodsPayload };
}

export interface ItemCtx {
  user_id: string;
  meal_type: MealType;
  source: string;
  dateObj: Date;
  scene?: string | null; // 进食场景 takeout/canteen/home/unknown，parser 提取（T32）；append 等无场景路径缺省
  itrace?: ItemTrace; // 由 processFoodItem 内部消费，不对外暴露
}

export interface ItemResult {
  record?: any;
  replyPart?: string;
  needsRecompute: boolean;
  pending?: any;
  pendingFn?: () => Promise<any>;
}

export async function processFoodItem(item: FoodItem, ctx: ItemCtx): Promise<ItemResult> {
  const { user_id, meal_type, source, dateObj, scene, itrace } = ctx;
  const { canonical, chosen_label, portions, food_confidence, portion_confidence, raw, is_ambiguous, ai_candidates, count, count_unit } = item;
  const query = canonical || raw;

  // 初始化 ItemTrace state
  if (itrace) {
    itrace.setState("canonical", canonical);
    itrace.setState("food_confidence", food_confidence);
    itrace.setState("portion_confidence", portion_confidence);
    itrace.setState("is_ambiguous", is_ambiguous);
  }

  // ── 用户食物直连（LEARNING_SPEC §6 §7，T30）──
  // streak≥2：跳过歧义判定与匹配，直用该食物；份量仍走正常置信度流程（不越权）。
  let food: FoodStandard | null = null;
  let matchedByHabit = false;
  const alias = await getFoodAlias(user_id, query);
  if (alias && alias.streak >= 2) {
    food = await prisma.foodStandard.findUnique({ where: { id: alias.food_id } });
    matchedByHabit = !!food;
  }

  let dbCandidates: FoodStandard[] = [];
  let calorie_spread = 0;

  if (!food) {
    const matched = await matchFoodCandidates(query);
    dbCandidates = matched.foods;
    calorie_spread = matched.calorie_spread;
    if (itrace) itrace.setState("calorie_spread", calorie_spread);

    const isAmbiguous =
      is_ambiguous ||
      (food_confidence < 0.85 && dbCandidates.length >= 2 && calorie_spread > FOOD_AMBIGUITY_SPREAD);

    if (isAmbiguous) {
      // normalize → confidence → decision → output（通过 itrace）
      if (itrace) {
        const na = { ...itrace.getState(), match_path: "ambiguous_pending", calorie_spread };
        await itrace.normalize(
          na,
          { canonical, raw },
          { candidates_count: dbCandidates.length, calorie_spread, match_path: "ambiguous_pending" },
        );

        const ca = { ...itrace.getState(), confidence_verdict: "ambiguous" };
        await itrace.confidence(
          ca,
          { food_confidence, portion_confidence, is_ambiguous, calorie_spread, candidates_count: dbCandidates.length },
          { food_level: food_confidence >= 0.8 ? "high" : food_confidence >= 0.5 ? "medium" : "low", portion_level: "low", verdict: "ambiguous" },
          { threshold_food_high: 0.8, threshold_portion_high: 0.8, threshold_food_low: 0.5, calorie_spread_max: FOOD_AMBIGUITY_SPREAD },
        );

        const da = { ...itrace.getState(), routing_action: "candidate_card" };
        await itrace.decision(
          da,
          { food_level: "medium", portion_level: "low", is_ambiguous, calorie_spread },
          { action: "candidate_card" },
          { reason: is_ambiguous ? "AI flagged is_ambiguous=true" : `calorie_spread (${calorie_spread}) > ${FOOD_AMBIGUITY_SPREAD}` },
        );
      }

      const { pendingRecord: pr, foodsPayload } = await buildCandidateCardData({
        user_id, query, raw, meal_type, source, portions, chosen_label, ai_candidates, scene, count, count_unit,
      });

      if (itrace) {
        const oa = { ...itrace.getState(), pending_id: pr.id };
        await itrace.output(
          oa,
          { action: "candidate_card" },
          { result: "pending_created", pending_record_id: pr.id },
        );
      }

      return {
        needsRecompute: false,
        pending: pr,
        pendingFn: () => prisma.chatMessage.create({
          data: {
            user_id, date: dateObj, role: "assistant", kind: "candidate_card",
            payload: { pending_id: pr.id, query, foods: foodsPayload } as object,
          },
        }),
      };
    }

    food = await matchFood(query, raw, user_id);
  }

  // ── 份量偏差应用（LEARNING_SPEC §5 §6，T31）──
  // 食物确定后，对各档克数应用该用户学到的份量偏差；冷启动/开关关闭时原样返回。
  // rawChosen 是 AI 原估（学习事件的 predicted 基准），biasedChosen 是展示/入库的值。
  const biases = biasEnabled() ? await getBiases(user_id, food.id, food.category, scene) : {};
  // custom 档是用户亲口报的精确克数（"149克"），是地面真值，绝不套学习偏差——
  // 偏差只修正 AI 的估档（小/中/大）。否则会把用户明示的重量"改"掉（149→125），
  // 且 predicted_grams 记原值、weight_g 记被改小的值，隐式确认还会 ln(应用/原估) 反向强化偏差（自污染）。
  const biasedPortions = portions.map((p) =>
    p.label === "custom" ? { ...p } : { ...p, grams: applyBias(p.grams, biases) });
  // chosen_label 缺档已在 schema 层归一化（T42 ensureChosenPortion）；此处兜底回退 medium，绝不回退小份
  const rawChosen = portions.find((p) => p.label === chosen_label)
    ?? portions.find((p) => p.label === "medium") ?? portions[0];
  const biasedChosen = biasedPortions.find((p) => p.label === chosen_label)
    ?? biasedPortions.find((p) => p.label === "medium") ?? biasedPortions[0];

  // ── normalize：canonical → food_standard 映射 ──
  if (itrace) {
    const matchPath = matchedByHabit ? "user_alias" : inferMatchPath(food, query, dbCandidates);
    const na: Record<string, unknown> = {
      ...itrace.getState(),
      matched_food_id: food.id,
      matched_food_name: food.name,
      match_path: matchPath,
      entity_type: "food_standard",
      entity_id: food.id,
    };

    await itrace.normalize(
      na,
      { canonical, raw },
      {
        match_path: matchPath,
        food_id: food.id,
        food_name: food.name,
        category: food.category,
        calories_100g: food.calories_100g,
        candidates_count: dbCandidates.length,
        calorie_spread,
        adjudicated_by_ai: (food as any)._adjudicated ?? false,
      },
    );
  }

  // ── confidence：根据双信号 + 置信度阈值判定 ──
  const foodLevel = food_confidence >= 0.8 ? "high" : food_confidence >= 0.5 ? "medium" : "low";
  const portionLevel = portion_confidence >= 0.8 ? "high" : portion_confidence >= 0.5 ? "medium" : "low";
  const verdict = food_confidence >= 0.8 && portion_confidence >= 0.8 ? "confident"
    : food_confidence < 0.5 ? "food_low" : "portion_uncertain";

  // ── confidence event：记录判据 + 阈值 + verdict ──
  if (itrace) {
    const ca = { ...itrace.getState(), confidence_verdict: verdict };
    await itrace.confidence(
      ca,
      { food_confidence, portion_confidence, is_ambiguous, calorie_spread, candidates_count: dbCandidates.length },
      { food_level: foodLevel, portion_level: portionLevel, verdict },
      { threshold_food_high: 0.8, threshold_portion_high: 0.8, threshold_food_low: 0.5, calorie_spread_max: FOOD_AMBIGUITY_SPREAD },
    );
  }

  if (food_confidence >= 0.8 && portion_confidence >= 0.8) {
    // ── decision + output：auto_commit 分支 ──
    if (itrace) {
      const da = { ...itrace.getState(), routing_action: "auto_commit", threshold_food_high: 0.8, threshold_portion_high: 0.8 };
      await itrace.decision(
        da,
        { food_level: foodLevel, portion_level: portionLevel, is_ambiguous, calorie_spread },
        { action: "auto_commit" },
        { reason: `food_confidence (${food_confidence}) >= 0.8 && portion_confidence (${portion_confidence}) >= 0.8` },
      );
    }

    const weight_g = biasedChosen.grams;
    const unit = (biasedChosen as any)?.unit ?? "g";
    const nutrition = itemNutrition(food, weight_g);

    const record = await prisma.foodRecord.create({
      data: {
        user_id, food_id: food.id, meal_type, portion_label: chosen_label as PortionLabel,
        weight_g, calories: nutrition.calories, protein: nutrition.protein_g,
        fat: nutrition.fat_g, carbs: nutrition.carbs_g,
        food_confidence, portion_confidence, source, raw_input: raw, date: dateObj,
        parse_log_id: itrace?.traceId || null,
        alias_canonical: matchedByHabit ? query : null,
        predicted_grams: rawChosen.grams,
        scene: scene ?? null,
        count: count ?? null,
        count_unit: count != null ? (count_unit ?? null) : null,
      },
    });

    if (itrace) {
      const oa = { ...itrace.getState(), record_id: record.id };
      await itrace.output(
        oa,
        { action: "auto_commit" },
        { result: "record_created", record_id: record.id, weight_g, calories: Math.round(nutrition.calories), protein: Math.round(nutrition.protein_g), fat: Math.round(nutrition.fat_g), carbs: Math.round(nutrition.carbs_g) },
      );
    }

    // 入库不逐食材发卡——卡片由调用方（record/append）统一挂该餐 meal_card，
    // 卡片级撤销由 meal_card 的 payload.last_changes 承载（T53 项级）。
    // alias 学习不受影响：直连命中仍写 alias_canonical，用户自然语言改食物时照旧触发 streak 清零。
    return {
      record,
      replyPart: `${food.name} ${weight_g}${unit}（约 ${Math.round(nutrition.calories)} kcal）`,
      needsRecompute: true,
    };
  }

  // ── decision + output：portion_card 分支（食物唯一但份量不明）──
  if (itrace) {
    const da = { ...itrace.getState(), routing_action: "portion_card", threshold_food_high: 0.8, threshold_portion_high: 0.8 };
    await itrace.decision(
      da,
      { food_level: foodLevel, portion_level: portionLevel, is_ambiguous, calorie_spread },
      { action: "portion_card" },
      { reason: `portion_confidence (${portion_confidence}) < 0.80` },
    );
  }

  // 份量卡展示与候选克数都用偏差修正后的值；predicted_grams 保留 AI 原估作学习基准
  const portionsWithCal = biasedPortions.map((p) => ({
    ...p,
    calories: p.grams > 0 ? Math.round(Number(food.calories_100g) * p.grams / 100) : undefined,
  }));
  const pr = await prisma.pendingRecord.create({
    data: {
      user_id, type: "portion_choice", raw_input: raw,
      candidates: {
        food_id: food.id, food_name: food.name, meal_type, source,
        portions: biasedPortions, chosen_label,
        predicted_grams: rawChosen.grams, applied_grams: biasedChosen.grams,
        scene: scene ?? null,
        count: count ?? null, count_unit: count != null ? (count_unit ?? null) : null,
      } as object,
    },
  });

  if (itrace) {
    const oa = { ...itrace.getState(), pending_id: pr.id };
    await itrace.output(
      oa,
      { action: "portion_card" },
      { result: "pending_created", pending_record_id: pr.id, food_name: food.name },
    );
  }

  return {
    needsRecompute: false,
    pending: pr,
    pendingFn: () => prisma.chatMessage.create({
      data: {
        user_id, date: dateObj, role: "assistant", kind: "portion_card",
        payload: { pending_id: pr.id, food_name: food.name, portions: portionsWithCal } as object,
      },
    }),
  };
}

// ---------- 批量处理食物条目（record 与 modify.append 共用循环） ----------
export interface ProcessItemsResult {
  records: any[];
  replyParts: string[];
  pending: any | null;
  needsRecompute: boolean;
  pendingCreateFns: Array<() => Promise<any>>;
}

export async function processItems(
  items: FoodItem[],
  baseCtx: Omit<ItemCtx, "itrace">,
  itemTrace: (idx: number) => ItemTrace,
): Promise<ProcessItemsResult> {
  const records: any[] = [];
  const replyParts: string[] = [];
  let pending: any | null = null;
  let needsRecompute = false;
  const pendingCreateFns: Array<() => Promise<any>> = [];

  for (let idx = 0; idx < items.length; idx++) {
    const r = await processFoodItem(items[idx], { ...baseCtx, itrace: itemTrace(idx) });
    if (r.record) records.push(r.record);
    if (r.replyPart) replyParts.push(r.replyPart);
    if (r.needsRecompute) needsRecompute = true;
    if (r.pending && !pending) pending = r.pending;
    if (r.pendingFn) pendingCreateFns.push(r.pendingFn);
  }

  return { records, replyParts, pending, needsRecompute, pendingCreateFns };
}
