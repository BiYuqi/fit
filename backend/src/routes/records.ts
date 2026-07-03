import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { itemNutrition } from "../services/calc";
import { recompute, buildContextCard } from "../services/summary";
import type { PortionLabel } from "@prisma/client";

// ─────────────────────────────────────────────
// POST /api/records/:id/undo  —— 撤销 modify 的 update/append（AI_PARSING_SPEC §8）
// 带 prev_state → 还原（update 撤销）；不带 → 删记录（append 撤销）
// ─────────────────────────────────────────────
const UndoBodySchema = z.object({
  prev_state: z.object({
    food_id: z.string(),
    portion_label: z.enum(["small", "medium", "large", "custom"]),
    weight_g: z.number().positive(),
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
      const prev = bodyParsed.data.prev_state;
      if (prev && "food_id" in prev) {
        // update 撤销 → 还原食物/份量/克数并重算
        const food = await prisma.foodStandard.findUnique({ where: { id: prev.food_id } });
        if (!food) {
          return reply.status(400).send({ error: { code: "invalid_food", message: "Previous food not found" } });
        }
        const nutrition = itemNutrition(food, prev.weight_g);
        await prisma.foodRecord.update({
          where: { id },
          data: {
            food_id: prev.food_id, portion_label: prev.portion_label as PortionLabel, weight_g: prev.weight_g,
            calories: nutrition.calories, protein: nutrition.protein_g, fat: nutrition.fat_g, carbs: nutrition.carbs_g,
          },
        });
      } else {
        // append 撤销 → 删新记录
        await prisma.foodRecord.delete({ where: { id } });
      }
      await recompute(user_id, recDate);
      const summary_card = await buildContextCard(user_id);
      return { ok: true, summary_card };
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
      return { ok: true, summary_card };
    }

    return reply.status(404).send({ error: { code: "not_found", message: "Record not found" } });
  });
}
