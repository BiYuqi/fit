import { z } from "zod";
import { prisma } from "../lib/prisma";
import { callDeepSeek } from "../ai/client";
import type { FoodStandard } from "@prisma/client";

// ---------- 估算食物复核（T33，FOOD_DB_SPEC §3 复合菜层/兜底层）----------
// is_estimated=true 的条目是 flash 兜底时一次性估的营养，被反复引用却从不复核。
// 周期 job：引用 ≥ REVIEW_MIN_REFS 且未复核过的条目，用 pro 带聚合上下文重估，
// 过护栏（能量自检 + 类目均值离群）才更新。不回改历史 food_record——历史记录是当时事实。

export const REVIEW_MIN_REFS = 3; // 触发复核的 food_record 引用次数
export const ENERGY_DIFF_MAX = 0.25; // 能量自检阈值，同 T03 导入口径
export const CATEGORY_OUTLIER_RATIO = 3; // 与类目均值偏离超 3 倍 → 放弃更新

export const ReviewEstimateSchema = z.object({
  calories_100g: z.number().positive(),
  protein_100g: z.number().min(0),
  fat_100g: z.number().min(0),
  carbs_100g: z.number().min(0),
  fiber_100g: z.number().min(0).optional(),
});
export type ReviewEstimate = z.infer<typeof ReviewEstimateSchema>;

export type ReviewVerdict = "updated" | "rejected_energy_check" | "rejected_category_outlier";

// ── 护栏（纯函数，供单测）──

// 能量自检（Atwater 近似）：4*蛋白 + 4*碳水 + 9*脂肪，与标注能量偏差 ≤ 25% 才可信
export function checkEnergy(v: ReviewEstimate): { ok: boolean; predicted: number; diffPct: number } {
  const predicted = 4 * v.protein_100g + 4 * v.carbs_100g + 9 * v.fat_100g;
  const diffPct = Math.abs(predicted - v.calories_100g) / v.calories_100g;
  return { ok: diffPct <= ENERGY_DIFF_MAX, predicted, diffPct };
}

// 判定：能量自检 → 类目均值离群（类目无标准层条目时 categoryMean=null，跳过该项）
export function evaluateReview(v: ReviewEstimate, categoryMean: number | null): ReviewVerdict {
  if (!checkEnergy(v).ok) return "rejected_energy_check";
  if (categoryMean != null && categoryMean > 0) {
    const ratio = v.calories_100g / categoryMean;
    if (ratio > CATEGORY_OUTLIER_RATIO || ratio < 1 / CATEGORY_OUTLIER_RATIO) {
      return "rejected_category_outlier";
    }
  }
  return "updated";
}

// ── pro 重估：纯食物知识调用，不带用户上下文（走 callDeepSeek，不走 ctx 记忆包）──

const REVIEW_TOOL_NAME = "review_nutrition";

const reviewTool = {
  type: "function" as const,
  function: {
    name: REVIEW_TOOL_NAME,
    strict: true,
    description: "复核并重新估算食物每100g可食部的营养成分",
    parameters: {
      type: "object",
      required: ["calories_100g", "protein_100g", "fat_100g", "carbs_100g"],
      additionalProperties: false,
      properties: {
        calories_100g: { type: "number", description: "每100g热量(kcal)" },
        protein_100g: { type: "number", description: "每100g蛋白质(g)" },
        fat_100g: { type: "number", description: "每100g脂肪(g)" },
        carbs_100g: { type: "number", description: "每100g碳水(g)" },
        fiber_100g: { type: "number", description: "每100g膳食纤维(g)" },
      },
    },
  },
};

interface CategoryStats {
  mean: number | null;
  min: number | null;
  max: number | null;
}

async function reviewByPro(
  food: FoodStandard,
  rawSamples: string[],
  cat: CategoryStats,
): Promise<ReviewEstimate> {
  const catLine =
    cat.mean != null
      ? `同类目（${food.category}）标准库热量均值约 ${Math.round(cat.mean)} kcal/100g（范围 ${Math.round(cat.min ?? 0)}~${Math.round(cat.max ?? 0)}），仅供参照，不必强行贴近。`
      : `该类目（${food.category}）暂无标准库条目可参照。`;
  const samplesLine = rawSamples.length > 0 ? `用户记录时的原话样本：${rawSamples.map((s) => `「${s}」`).join("、")}。` : "";

  const res = await callDeepSeek(
    [
      {
        role: "system",
        content:
          "你是营养专家，复核一条此前由 AI 快速估算的食物营养数据。请根据食物名称、类目、用户真实记录的原话样本，重新给出每100g可食部的营养成分。数值必须自洽：热量 ≈ 4×蛋白质 + 4×碳水 + 9×脂肪（kcal）。",
      },
      {
        role: "user",
        content:
          `食物「${food.name}」（类目：${food.category}${food.is_composite ? "，复合菜肴" : ""}）。` +
          `当前估算值：${food.calories_100g} kcal、蛋白 ${food.protein_100g}g、脂肪 ${food.fat_100g}g、碳水 ${food.carbs_100g}g /100g。` +
          samplesLine +
          catLine +
          "请重新估算并输出。",
      },
    ],
    {
      model: "deepseek-v4-pro",
      tools: [reviewTool],
      tool_choice: { type: "function", function: { name: REVIEW_TOOL_NAME } },
    },
  );
  // 系统 job 无归属用户，token_usage.user_id 必填 FK，此处不记账（周级低频，成本可忽略）

  const toolCall = res.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("pro review returned no tool call");
  }
  return ReviewEstimateSchema.parse(JSON.parse(toolCall.function.arguments));
}

// ── job 主体：找待复核条目 → 逐条 pro 重估 → 护栏 → 更新/标记 ──
// 幂等：food_review_log 有行即视为已复核（updated 已改 source；rejected 留待人工，不自动重试）。
// 单条失败（如 API 抖动）只跳过不写日志，下次运行自然重试。
export interface ReviewJobResult {
  scanned: number;
  updated: number;
  rejected: number;
  failed: number;
}

export async function runEstimatedFoodReviewJob(minRefs = REVIEW_MIN_REFS): Promise<ReviewJobResult> {
  const candidates = await prisma.foodStandard.findMany({
    where: {
      is_estimated: true,
      review_logs: { none: {} },
    },
    include: { _count: { select: { food_records: true } } },
  });
  const due = candidates.filter((f) => f._count.food_records >= minRefs);

  const result: ReviewJobResult = { scanned: due.length, updated: 0, rejected: 0, failed: 0 };

  for (const food of due) {
    try {
      // 聚合上下文：被记录时的原话样本（去重取最近 5 条）+ 同类目标准层热量统计
      const recs = await prisma.foodRecord.findMany({
        where: { food_id: food.id, raw_input: { not: null } },
        select: { raw_input: true },
        distinct: ["raw_input"],
        orderBy: { created_at: "desc" },
        take: 5,
      });
      const rawSamples = recs.map((r) => r.raw_input!).filter(Boolean);

      const agg = await prisma.foodStandard.aggregate({
        where: { category: food.category, is_estimated: false, calories_100g: { not: null } },
        _avg: { calories_100g: true },
        _min: { calories_100g: true },
        _max: { calories_100g: true },
      });
      const cat: CategoryStats = { mean: agg._avg.calories_100g, min: agg._min.calories_100g, max: agg._max.calories_100g };

      const estimate = await reviewByPro(food, rawSamples, cat);
      const verdict = evaluateReview(estimate, cat.mean);

      if (verdict === "updated") {
        // source 标 ai_reviewed，is_estimated 保持 true（仍是估算，只是可信度更高）
        await prisma.foodStandard.update({
          where: { id: food.id },
          data: {
            calories_100g: estimate.calories_100g,
            protein_100g: estimate.protein_100g,
            fat_100g: estimate.fat_100g,
            carbs_100g: estimate.carbs_100g,
            fiber_100g: estimate.fiber_100g ?? food.fiber_100g,
            source: "ai_reviewed",
          },
        });
        result.updated++;
      } else {
        result.rejected++;
      }

      await prisma.foodReviewLog.create({
        data: {
          food_id: food.id,
          status: verdict,
          old_values: {
            calories_100g: food.calories_100g,
            protein_100g: food.protein_100g,
            fat_100g: food.fat_100g,
            carbs_100g: food.carbs_100g,
            fiber_100g: food.fiber_100g,
          },
          new_values: estimate,
          category_mean: cat.mean,
          ref_count: food._count.food_records,
        },
      });
    } catch (err) {
      result.failed++;
      console.error(`复核失败（下次运行重试）: ${food.name}`, err);
    }
  }

  return result;
}
