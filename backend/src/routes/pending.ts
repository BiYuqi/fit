import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { todayStr, toDateOnly, guessMealType } from "../lib/dates";
import { matchFood } from "../services/matcher";
import { itemNutrition } from "../services/calc";
import { recompute, buildContextCard } from "../services/summary";
import { recordDeleteCorrection, recordResolveCorrection } from "../services/trace";
import type { MealType, PortionLabel } from "@prisma/client";

const ResolveBodySchema = z.object({
  choice: z.union([
    z.string().min(1),                        // portion label ("small"/"medium"/"large") 或食物名
    z.object({ grams: z.number().positive() }), // 自定义克数（portion_card）
  ]),
});

export async function pendingRoutes(app: FastifyInstance) {
  const auth = (req: any, reply: any) => app.authenticate(req, reply);

  // ─────────────────────────────────────────────
  // POST /api/pending/:id/resolve
  // ─────────────────────────────────────────────
  app.post("/api/pending/:id/resolve", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const { id } = req.params as { id: string };

    const bodyParsed = ResolveBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: bodyParsed.error.message } });
    }
    const { choice } = bodyParsed.data;

    const pr = await prisma.pendingRecord.findFirst({
      where: { id, user_id, status: "pending" },
    });
    if (!pr) {
      return reply.status(404).send({ error: { code: "not_found", message: "Pending record not found or already resolved" } });
    }

    const candidates = pr.candidates as any;
    const today = todayStr();
    const dateObj = toDateOnly(today);
    const meal_type = (candidates.meal_type ?? guessMealType()) as MealType;
    const source: string = candidates.source ?? "text";

    // delete_confirm：用户点了确认 → 删记录（AI_PARSING_SPEC §8）
    // 不额外创建 text 消息——前端的 delete_confirm_card 本身在 resolved 后会显示"已删除「xxx」"
    if (pr.type === "delete_confirm") {
      if (candidates.kind === "exercise") {
        await prisma.exerciseRecord.deleteMany({ where: { id: candidates.record_id, user_id } });
      } else {
        await prisma.foodRecord.deleteMany({ where: { id: candidates.record_id, user_id } });
      }
      await prisma.pendingRecord.update({ where: { id }, data: { status: "resolved" } });
      await recompute(user_id, today);
      const summary_card = await buildContextCard(user_id);
      // Trace: correction event（用户确认删除）
      recordDeleteCorrection({
        userId: user_id,
        recordId: candidates.record_id,
        kind: candidates.kind,
        name: candidates.name,
        pendingId: id,
      });
      return { summary_card, messages: [] };
    }

    let food_id: string;
    let weight_g: number;
    let portion_label: PortionLabel;
    let resolved_unit = "g";

    if (pr.type === "portion_choice") {
      food_id = candidates.food_id as string;
      const portions: Array<{ label: string; grams: number; unit?: string }> = candidates.portions ?? [];

      if (typeof choice === "object" && "grams" in choice) {
        weight_g = choice.grams;
        portion_label = "custom";
      } else {
        const chosen = portions.find((p) => p.label === choice) ?? portions.find((p) => p.label === "medium") ?? portions[0];
        weight_g = chosen?.grams ?? 150;
        portion_label = (chosen?.label ?? "medium") as PortionLabel;
        resolved_unit = chosen?.unit ?? "g";
      }
    } else {
      // food_choice：choice 是食物名（string），用 matchFood 查找/估算
      // 不直接落库，而是生成 portion_choice pending → 返回 PortionCard（两步走）
      const foodName = choice as string;
      const food = await matchFood(foodName, undefined, user_id);

      const portionsList: Array<{ label: string; grams: number }> = candidates.portions ?? [];
      const portionsWithCal = portionsList.map((p) => ({
        ...p,
        calories: p.grams > 0 ? Math.round(Number(food.calories_100g) * p.grams / 100) : undefined,
      }));

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
          } as object,
        },
      });

      await prisma.pendingRecord.update({ where: { id }, data: { status: "resolved" } });

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
      return { summary_card, messages: [portionCardMsg] };
    }

    const food = await prisma.foodStandard.findUnique({ where: { id: food_id } });
    if (!food) {
      return reply.status(400).send({ error: { code: "invalid_food", message: "Food not found" } });
    }

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

    const aiMsg = await prisma.chatMessage.create({
      data: {
        user_id,
        date: dateObj,
        role: "assistant",
        kind: "record_card",
        content: `已确认：${food.name} ${weight_g}${resolved_unit}（约 ${Math.round(nutrition.calories)} kcal）`,
        payload: {
          food_name: food.name,
          weight_g,
          unit: resolved_unit,
          calories: Math.round(nutrition.calories),
          protein_g: Math.round(nutrition.protein_g),
          fat_g: Math.round(nutrition.fat_g),
          carbs_g: Math.round(nutrition.carbs_g),
          is_estimated: food.is_estimated,
        } as object,
        record_id: record.id as string,
      },
    });

    return { record, summary_card, messages: [aiMsg] };
  });
}
