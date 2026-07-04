import { z } from "zod";
import { prisma } from "../lib/prisma";
import { callDeepSeek } from "../ai/client";
import { recordTokenUsage } from "./token";
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

async function estimateByAI(canonical: string, raw: string = canonical, userId?: string): Promise<FoodStandard> {
  const res = await callDeepSeek(
    [
      {
        role: "system",
        content: "你是营养专家，根据食物名称估算每100g可食部的营养成分。复合菜肴(炒菜/汤/面等)标记is_composite=true。",
      },
      { role: "user", content: `请估算"${canonical}"（用户原话："${raw}"）的营养成分` },
    ],
    {
      model: "deepseek-v4-flash",
      tools: [estimateTool],
      tool_choice: { type: "function", function: { name: ESTIMATE_TOOL_NAME } },
    }
  );

  // 记录 token 用量（在 validation 之前——token 已消耗）
  if (userId) {
    const u = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    await recordTokenUsage({
      userId,
      model: "deepseek-v4-flash",
      purpose: "estimate",
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
    });
  }

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

// ---------- AI 裁决（字面召回的弱匹配回灌 DeepSeek 把关） ----------
// 字面相似（前缀/trgm）只负责"召回"，最终裁决权归 AI：
// 用户原话 + 候选(名/类目/热量) → AI 选中真正所指，或选 "none" 走估算。
// 类目仅作判断信息不硬排除；"以上都不是"是显式一等选项，不诱导硬选。
const ADJUDICATE_TOOL_NAME = "pick_food_match";

async function adjudicateByAI(
  raw: string,
  canonical: string,
  candidates: FoodStandard[],
  userId?: string,
): Promise<FoodStandard | null> {
  const opts = candidates.map((f, i) => ({ id: `c${i}`, food: f }));
  const optionsText = opts
    .map((o) => `${o.id}: ${o.food.name}（类目:${o.food.category}，约 ${Math.round(Number(o.food.calories_100g) || 0)} kcal/100g）`)
    .join("\n");

  const adjudicateTool = {
    type: "function" as const,
    function: {
      name: ADJUDICATE_TOOL_NAME,
      strict: true,
      description: "从候选食物里选出用户真正所指的那个；若没有相符的就选 none。",
      parameters: {
        type: "object",
        required: ["choice"],
        additionalProperties: false,
        properties: {
          choice: {
            type: "string",
            enum: [...opts.map((o) => o.id), "none"],
            description: "选中候选的 id；若候选里没有与用户所指真正相符的，选 none",
          },
        },
      },
    },
  };

  const res = await callDeepSeek(
    [
      {
        role: "system",
        content:
`你是食物匹配裁判。用户用自己的话描述了一种食物，下面是数据库按"字面相似度"召回的候选——可能有字面像、实际不是同一种东西的（例如"蛋白"指鸡蛋的蛋清，却召回了"蛋白粉"补剂）。判断哪个候选才是用户真正所指。
规则：
- 类目/常识不符的不要选（如蛋清属蛋类，蛋白粉属补剂/乳类，二者热量差好几倍，不可互替）。类目信息供你参考。
- **生/熟不符不要选**：候选是生食材/干货/生重条目（名称含"生""干""挂面"，或本就是未烹饪的干货如"糙米""大米""黄豆"），而用户描述的是吃的熟食/成品（如"糙米饭""一碗面""米饭"）→ 二者热量差 2~3 倍，**判不相符，选 none**（系统会按熟食估算）。除非用户明说"生的/干的"。
- 不确定，或候选里没有真正对应的 → **必须选 none**。选 none 完全正当，系统会改用营养估算；不要硬从候选里挑一个凑数。`,
      },
      {
        role: "user",
        content: `用户原话：「${raw}」\n归一名：${canonical}\n候选：\n${optionsText}`,
      },
    ],
    {
      model: "deepseek-v4-flash",
      tools: [adjudicateTool],
      tool_choice: { type: "function", function: { name: ADJUDICATE_TOOL_NAME } },
    },
  );

  // 记录 token 用量（在 validation 之前——token 已消耗）
  if (userId) {
    const u = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    await recordTokenUsage({
      userId,
      model: "deepseek-v4-flash",
      purpose: "adjudicate",
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: u.total_tokens,
    });
  }

  const toolCall = res.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") return null;
  let choice: string;
  try {
    choice = JSON.parse(toolCall.function.arguments).choice;
  } catch {
    return null;
  }
  if (choice === "none") return null;
  return opts.find((o) => o.id === choice)?.food ?? null;
}

// ---------- 候选列表（不做 AI 兜底，供 food_choice pending 展示） ----------
// 不做 early-return：精确匹配到也继续查前缀/trgm，汇总后去重，
// 让调用方根据 calorie_spread 决定是否歧义。
export async function matchFoodCandidates(
  canonical: string,
  limit = 5,
): Promise<{ foods: FoodStandard[]; calorie_spread: number }> {
  const collected: FoodStandard[] = [];
  const seen = new Set<string>();

  const add = (f: FoodStandard) => {
    if (!seen.has(f.id)) { seen.add(f.id); collected.push(f); }
  };

  // 1. 精确匹配
  const exact = await prisma.foodStandard.findFirst({ where: { name: canonical } });
  if (exact) add(exact);

  // 2. alias 匹配
  const byAlias = await prisma.foodStandard.findFirst({ where: { aliases: { has: canonical } } });
  if (byAlias) add(byAlias);

  // 3. 前缀匹配（"煎饼" → 煎饼果子 / 鸡蛋煎饼 …）
  const prefixResults = await prisma.foodStandard.findMany({
    where: { name: { startsWith: canonical }, is_estimated: false },
    orderBy: { name: 'asc' },
    take: limit,
  });
  prefixResults.forEach(add);

  // 4. pg_trgm 模糊匹配（补漏别名拼写变体）
  const trgmResults = await prisma.$queryRaw<Array<FoodStandard & { _sim: number }>>`
    SELECT *, similarity(name, ${canonical}) AS _sim
    FROM "FoodStandard"
    WHERE similarity(name, ${canonical}) >= ${SIMILARITY_THRESHOLD}
      AND is_estimated = false
    ORDER BY _sim DESC
    LIMIT ${limit}
  `;
  trgmResults.forEach((r) => {
    const { _sim, ...food } = r as any;
    add(food as FoodStandard);
  });

  const foods = collected.slice(0, limit);

  // 计算热量离散度（每100g）
  const cals = foods.map((f) => Number(f.calories_100g)).filter((c) => c > 0);
  const calorie_spread = cals.length >= 2
    ? Math.max(...cals) - Math.min(...cals)
    : 0;

  return { foods, calorie_spread };
}

// ---------- 主管线 ----------
// ---------- 精确匹配或估算（不走弱匹配裁决，T40 属性修正专用）----------
// modify.update change.food_desc 构造的具体变体名（如"葱花饼（无油）"）只信任精确同名/别名命中
// （说明这个变体之前已被估算过）；否则强制重新估算。不走 trgm/AI 裁决——那条链路是为了把"字面像
// 但不确定是不是同一种东西"的候选交给 AI 把关，而属性修正的前提恰恰是"原条目的营养口径不对"，
// 若走弱匹配，trgm 几乎必然召回原条目（字面高度相似），AI 裁决又缺乏"无油/无糖"这类营养口径信号，
// 容易误判为同一种从而复用旧营养值，导致修正静默失效（用户以为改了，数据其实没变）。
export async function matchFoodExactOrEstimate(canonical: string, raw: string = canonical, userId?: string): Promise<FoodStandard> {
  const exact = await prisma.foodStandard.findFirst({ where: { name: canonical } });
  if (exact) return exact;
  const byAlias = await prisma.foodStandard.findFirst({ where: { aliases: { has: canonical } } });
  if (byAlias) return byAlias;
  return estimateByAI(canonical, raw, userId);
}

// 字面匹配只做"召回"，不做"裁决"：精确/alias 可信任直用；前缀(假前缀)/trgm 属弱匹配，
// 回灌 AI 把关；AI 否决或无候选 → 估算落库。详见 AI_PARSING_SPEC §5。
export async function matchFood(canonical: string, raw: string = canonical, userId?: string): Promise<FoodStandard> {
  // 1. 精确匹配 → 可信
  const exact = await prisma.foodStandard.findFirst({ where: { name: canonical } });
  if (exact) return exact;

  // 2. aliases 匹配 → 可信
  const byAlias = await prisma.foodStandard.findFirst({ where: { aliases: { has: canonical } } });
  if (byAlias) return byAlias;

  // 弱匹配候选（前缀假命中 + trgm），交 AI 裁决
  const suspects: FoodStandard[] = [];
  const seen = new Set<string>();
  const addSuspect = (f: FoodStandard) => { if (!seen.has(f.id)) { seen.add(f.id); suspects.push(f); } };

  // 3. 前缀匹配：区分"真 specialization"与"假前缀撞词"
  //    真：name==canonical，或 canonical 之后紧跟分隔符（如 纯牛奶→纯牛奶（全脂…）→ 可信直用
  //    假：canonical 后接正文字（如 蛋白→蛋白粉）→ 转可疑候选
  const prefixResults = await prisma.foodStandard.findMany({
    where: { name: { startsWith: canonical }, is_estimated: false },
    orderBy: { name: 'asc' },
    take: 5,
  });
  // 真 specialization：分隔符限定符；但限定符含"生/干"等生重标记的不算（如 面条（生，代表值）），
  // 降为可疑候选交裁决——没人记生食，除非用户明说。
  const RAW_MARKER = /生|干切|切面|挂面|（干|\(干/;
  const isTrueSpec = (name: string) => {
    if (name === canonical) return true;
    const qualifier = name.slice(canonical.length);
    if (!/^[（(\s、，,]/.test(qualifier)) return false;
    return !RAW_MARKER.test(qualifier);
  };
  const trueSpecs = prefixResults.filter((r) => isTrueSpec(r.name));
  if (trueSpecs.length > 0) {
    return trueSpecs.find((r) => r.name.includes('代表值')) ?? trueSpecs[0];
  }
  prefixResults.forEach(addSuspect);

  // 4. pg_trgm 模糊匹配 → 可疑候选
  const trgmResults = await prisma.$queryRaw<Array<FoodStandard & { _sim: number }>>`
    SELECT *, similarity(name, ${canonical}) AS _sim
    FROM "FoodStandard"
    WHERE similarity(name, ${canonical}) >= ${SIMILARITY_THRESHOLD}
    ORDER BY _sim DESC
    LIMIT ${TRGM_LIMIT}
  `;
  trgmResults.forEach((r) => { const { _sim, ...food } = r as any; addSuspect(food as FoodStandard); });

  // 5. 无任何候选 → AI 估算兜底
  if (suspects.length === 0) return estimateByAI(canonical, raw, userId);

  // 6. 有可疑候选 → AI 裁决（带用户原话）
  const picked = await adjudicateByAI(raw, canonical, suspects.slice(0, 5), userId);
  if (picked) return picked;

  // 7. AI 否决（"以上都不是"）→ 估算落库，宁可估算不硬套
  return estimateByAI(canonical, raw, userId);
}