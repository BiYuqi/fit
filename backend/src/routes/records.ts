import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { itemNutrition } from "../services/calc";
import { recompute, buildContextCard } from "../services/summary";
import { resetFoodAliasStreak } from "../services/learning";
import { refreshMealCard } from "../services/meal-card";
import { toDateOnly } from "../lib/dates";
import type { ChatMessage, MealType, PortionLabel } from "@prisma/client";

// ─────────────────────────────────────────────
// POST /api/records/:id/undo  —— 撤销 modify 的 update/append（AI_PARSING_SPEC §8）
// 带 prev_state → 还原（update 撤销）；不带 → 删记录（append 撤销）
// ─────────────────────────────────────────────
const UndoBodySchema = z.object({
  prev_state: z.object({
    food_id: z.string(),
    portion_label: z.enum(["small", "medium", "large", "custom"]),
    weight_g: z.number().positive(),
    meal_type: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(), // 改餐次的撤销还原
    // T40：改前的精确营养快照。存在时直接还原这些值，而不是按 food×grams 重算——
    // user_override 的记录 food×grams 算出来的值本就和落库值不同，重算会丢失用户真值。
    calories: z.number().optional(),
    protein: z.number().optional(),
    fat: z.number().optional(),
    carbs: z.number().optional(),
    calories_source: z.string().optional(),
    date: z.string().optional(), // T62：改日期的撤销还原，"YYYY-MM-DD"
  }).or(z.object({
    calories_burned: z.number().positive(),
    kind: z.literal("exercise"),
  })).optional(),
});

export async function recordsRoutes(app: FastifyInstance) {
  const auth = (req: any, reply: any) => app.authenticate(req, reply);

  app.post("/api/records/:id/undo", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const { id } = req.params as { id: string };
    const bodyParsed = UndoBodySchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: bodyParsed.error.message } });
    }

    // 先试食物记录，再试运动记录
    const foodRec = await prisma.foodRecord.findFirst({ where: { id, user_id } });
    if (foodRec) {
      const recDate = foodRec.date.toISOString().slice(0, 10);
      // 学习信号（LEARNING_SPEC §7）：撤销一条用户食物直连自动匹配的记录 → 清零该 alias 的 streak
      // ——UI 撤销了，模型也要撤销，否则下次还是自动记错
      if (foodRec.alias_canonical) {
        resetFoodAliasStreak(user_id, foodRec.alias_canonical);
      }
      const prev = bodyParsed.data.prev_state;
      if (prev && "food_id" in prev) {
        // update 撤销 → 还原食物/份量/克数
        const food = await prisma.foodStandard.findUnique({ where: { id: prev.food_id } });
        if (!food) {
          return reply.status(400).send({ error: { code: "invalid_food", message: "Previous food not found" } });
        }
        // 有精确营养快照（T40 起）→ 直接还原，不按 food×grams 重算——
        // user_override 记录的落库值本就不等于 food×grams 算出来的值，重算会丢失用户真值
        const hasExactSnapshot = prev.calories != null && prev.protein != null && prev.fat != null && prev.carbs != null;
        const nutrition = hasExactSnapshot
          ? { calories: prev.calories!, protein_g: prev.protein!, fat_g: prev.fat!, carbs_g: prev.carbs! }
          : itemNutrition(food, prev.weight_g);
        await prisma.foodRecord.update({
          where: { id },
          data: {
            food_id: prev.food_id, portion_label: prev.portion_label as PortionLabel, weight_g: prev.weight_g,
            meal_type: (prev.meal_type as MealType | undefined) ?? undefined,
            calories: nutrition.calories, protein: nutrition.protein_g, fat: nutrition.fat_g, carbs: nutrition.carbs_g,
            calories_source: prev.calories_source ?? "computed",
            ...(prev.date ? { date: toDateOnly(prev.date) } : {}), // T62：改日期的撤销还原
          },
        });
      } else {
        // append 撤销 → 删新记录
        await prisma.foodRecord.delete({ where: { id } });
      }
      // T62：撤销的目标日（改日期前的原归属日），没改过日期就还是 recDate 本身
      const restoredDate = (prev && "food_id" in prev ? prev.date : undefined) ?? recDate;
      await recompute(user_id, recDate);
      if (restoredDate !== recDate) await recompute(user_id, restoredDate);
      const summary_card = await buildContextCard(user_id);

      // T47/T53：撤销后原地刷新受影响餐卡并随响应返回；本条撤销态已消费 → 只 clear 这一条
      // （批量改时同卡其他记录的撤销态保留）。改餐次/改日期的撤销是双卡：撤销前所在餐（卡上挂着撤销
      // 按钮的那张）先 bump，还原后所在餐（prev_state.meal_type/date）后 bump 浮到最末。只 bump 已存在的卡。
      const messages: ChatMessage[] = [];
      const restoredMeal = (prev && "food_id" in prev ? (prev.meal_type as MealType | undefined) : undefined) ?? foodRec.meal_type;
      await refreshMealCard(messages, {
        user_id, mealDate: recDate, meal_type: foodRec.meal_type,
        chatDate: foodRec.date, lastChange: { op: "clear", record_id: id }, createIfMissing: false,
      });
      if (restoredMeal !== foodRec.meal_type || restoredDate !== recDate) {
        await refreshMealCard(messages, {
          user_id, mealDate: restoredDate, meal_type: restoredMeal,
          chatDate: foodRec.date, lastChange: { op: "clear", record_id: id }, createIfMissing: false,
        });
      }
      return { ok: true, summary_card, messages };
    }

    const exRec = await prisma.exerciseRecord.findFirst({ where: { id, user_id } });
    if (exRec) {
      const recDate = exRec.date.toISOString().slice(0, 10);
      const prev = bodyParsed.data.prev_state;
      if (prev && "kind" in prev && prev.kind === "exercise") {
        // update 撤销 → 还原消耗热量
        await prisma.exerciseRecord.update({
          where: { id },
          data: { calories_burned: prev.calories_burned },
        });
      } else {
        // 无 prev_state → 删记录（append 撤销）
        await prisma.exerciseRecord.delete({ where: { id } });
      }
      await recompute(user_id, recDate);
      const summary_card = await buildContextCard(user_id);
      // 运动撤销不涉及 meal_card；messages 恒空，字段形状与食物分支一致
      return { ok: true, summary_card, messages: [] };
    }

    return reply.status(404).send({ error: { code: "not_found", message: "Record not found" } });
  });
}
