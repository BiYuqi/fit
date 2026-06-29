import { z } from "zod";
import { prisma } from "../lib/prisma";
import { callDeepSeek } from "../ai/client";
import type { FoodStandard } from "@prisma/client";

const SIMILARITY_THRESHOLD = 0.4;
const TRGM_LIMIT = 5;

// ---------- AI 估算 schema ----------
const EstimateSchema = z.object({
  calories_100g: z.number().positive(),
  protein_100g: z.number().min(0),
  fat_100g: z.number().min(0),
  carbs_100g: z.number().min(0),
  fiber_100g: z.number().min(0).optional(),
  is_composite: z.boolean(),
  category: z.string(),
});

const ESTIMATE_TOOL_NAME = "estimate_nutrition";

const estimateTool = {
  type: "function" as const,
  function: {
    name: ESTIMATE_TOOL_NAME,
    strict: true,
    description: "估算食物每100g的营养成分",
    parameters: {
      type: "object",
      required: ["calories_100g", "protein_100g", "fat_100g", "carbs_100g", "is_composite", "category"],
      additionalProperties: false,
      properties: {
        calories_100g: { type: "number", description: "每100g热量(kcal)" },
        protein_100g: { type: "number", description: "每100g蛋白质(g)" },
        fat_100g: { type: "number", description: "每100g脂肪(g)" },
        carbs_100g: { type: "number", description: "每100g碳水(g)" },
        fiber_100g: { type: "number", description: "每100g膳食纤维(g)" },
        is_composite: { type: "boolean", description: "是否复合菜肴(非单一食材)" },
        category: { type: "string", description: "食物类别，如'谷类及其制品'、'复合菜肴'" },
      },
    },
  },
};

async function estimateByAI(canonical: string): Promise<FoodStandard> {
  const res = await callDeepSeek(
    [
      {
        role: "system",
        content: "你是营养专家，根据食物名称估算每100g可食部的营养成分。复合菜肴(炒菜/汤/面等)标记is_composite=true。",
      },
      { role: "user", content: `请估算"${canonical}"的营养成分` },
    ],
    {
      model: "deepseek-v4-flash",
      tools: [estimateTool],
      tool_choice: { type: "function", function: { name: ESTIMATE_TOOL_NAME } },
    }
  );

  const toolCall = res.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("AI estimation returned no tool call");
  }

  const est = EstimateSchema.parse(JSON.parse(toolCall.function.arguments));

  return prisma.foodStandard.create({
    data: {
      name: canonical,
      category: est.category,
      calories_100g: est.calories_100g,
      protein_100g: est.protein_100g,
      fat_100g: est.fat_100g,
      carbs_100g: est.carbs_100g,
      fiber_100g: est.fiber_100g ?? null,
      is_composite: est.is_composite,
      is_estimated: true,
      source: "ai",
    },
  });
}

// ---------- 候选列表（不做 AI 兜底，供 food_choice pending 展示） ----------
export async function matchFoodCandidates(canonical: string, limit = 5): Promise<FoodStandard[]> {
  const exact = await prisma.foodStandard.findFirst({ where: { name: canonical } });
  if (exact) return [exact];

  const byAlias = await prisma.foodStandard.findFirst({ where: { aliases: { has: canonical } } });
  if (byAlias) return [byAlias];

  const prefixResults = await prisma.foodStandard.findMany({
    where: { name: { startsWith: canonical }, is_estimated: false },
    orderBy: { name: 'asc' },
    take: limit,
  });
  if (prefixResults.length > 0) return prefixResults;

  const results = await prisma.$queryRaw<Array<FoodStandard & { _sim: number }>>`
    SELECT *, similarity(name, ${canonical}) AS _sim
    FROM "FoodStandard"
    WHERE similarity(name, ${canonical}) >= ${SIMILARITY_THRESHOLD}
    ORDER BY _sim DESC
    LIMIT ${limit}
  `;
  return results.map((r) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _sim, ...food } = r as any;
    return food as FoodStandard;
  });
}

// ---------- 主管线 ----------
export async function matchFood(canonical: string): Promise<FoodStandard> {
  // 1. 精确匹配
  const exact = await prisma.foodStandard.findFirst({
    where: { name: canonical },
  });
  if (exact) return exact;

  // 2. aliases 匹配
  const byAlias = await prisma.foodStandard.findFirst({
    where: { aliases: { has: canonical } },
  });
  if (byAlias) return byAlias;

  // 2.5 前缀匹配："纯牛奶" → "纯牛奶（全脂，伊利牌）"
  // 优先选"代表值"条目，否则取第一条非估算结果
  const prefixResults = await prisma.foodStandard.findMany({
    where: { name: { startsWith: canonical }, is_estimated: false },
    orderBy: { name: 'asc' },
    take: 5,
  });
  if (prefixResults.length > 0) {
    return prefixResults.find(r => r.name.includes('代表值')) ?? prefixResults[0];
  }

  // 3. pg_trgm 模糊匹配
  const trgmResults = await prisma.$queryRaw<Array<FoodStandard & { _sim: number }>>`
    SELECT *, similarity(name, ${canonical}) AS _sim
    FROM "FoodStandard"
    WHERE similarity(name, ${canonical}) >= ${SIMILARITY_THRESHOLD}
    ORDER BY _sim DESC
    LIMIT ${TRGM_LIMIT}
  `;
  if (trgmResults.length > 0) return trgmResults[0];

  // 4. AI 估算兜底 → 落库 → 返回
  return estimateByAI(canonical);
}
