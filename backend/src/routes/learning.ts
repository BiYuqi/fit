import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { recompute, buildContextCard } from "../services/summary";
import { recordLearningEvent, resetFoodAliasStreak } from "../services/learning";
import { buildCandidateCardData } from "../services/intents/food-item";

const ResetBodySchema = z.object({
  canonical: z.string().min(1),
  record_id: z.string().uuid(),
  portions: z.array(z.object({
    label: z.enum(["small", "medium", "large", "custom"]),
    grams: z.number().positive(),
    unit: z.enum(["g", "ml"]).optional().default("g"),
  })).min(1),
  chosen_label: z.enum(["small", "medium", "large", "custom"]),
  ai_candidates: z.array(z.string()).optional(),
});

export async function learningRoutes(app: FastifyInstance) {
  const auth = (req: any, reply: any) => app.authenticate(req, reply);

  // ─────────────────────────────────────────────
  // POST /api/learning/alias/reset —— 「不是它？」逃生口（LEARNING_SPEC §7，T30）
  // 用户食物直连（streak≥2）自动匹配错了，点此撤销该条误判记录、清零该 alias 的
  // streak、重新走一次候选流程（重发 CandidateCard），让用户重新选。
  // ─────────────────────────────────────────────
  app.post("/api/learning/alias/reset", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const bodyParsed = ResetBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: bodyParsed.error.message } });
    }
    const { canonical, record_id, portions, chosen_label, ai_candidates } = bodyParsed.data;

    const rec = await prisma.foodRecord.findFirst({
      where: { id: record_id, user_id },
      include: { food: true },
    });
    if (!rec) {
      return reply.status(404).send({ error: { code: "not_found", message: "Record not found" } });
    }

    // 清零 streak——不是删 alias 记录，是"重新观察"：需要再连续选够 streak 次才会重新跳卡
    await resetFoodAliasStreak(user_id, canonical);

    // 学习信号（LEARNING_SPEC §3）：删除只记事件不训练。
    // 必须在 delete 之前写入——learning_event.food_record_id 有外键约束（见 T29 实现记录的坑）。
    await recordLearningEvent({
      user_id,
      food_record_id: rec.id,
      food_id: rec.food_id,
      category: rec.food?.category ?? null,
      predicted_grams: rec.weight_g,
      final_grams: rec.weight_g,
      predicted_label: rec.portion_label,
      final_label: rec.portion_label,
      signal_type: "delete",
      scene: rec.scene,
    });

    // 撤销这条误判记录——类比 append 撤销：直接删，让用户重新走候选卡选对的
    const recDateStr = rec.date.toISOString().slice(0, 10);
    await prisma.foodRecord.delete({ where: { id: rec.id } });
    await recompute(user_id, recDateStr);

    // 重新走候选流程：不复用旧的匹配结果（AI 判过一次已经错了），用同一份份量估算重新产出候选卡
    const { pendingRecord, foodsPayload } = await buildCandidateCardData({
      user_id,
      query: canonical,
      raw: rec.raw_input ?? canonical,
      meal_type: rec.meal_type,
      source: rec.source,
      portions,
      chosen_label,
      ai_candidates,
      scene: rec.scene,
    });

    const candidateCardMsg = await prisma.chatMessage.create({
      data: {
        user_id, date: rec.date, role: "assistant", kind: "candidate_card",
        payload: { pending_id: pendingRecord.id, query: canonical, foods: foodsPayload } as object,
      },
    });

    const summary_card = await buildContextCard(user_id);
    return { summary_card, messages: [candidateCardMsg] };
  });
}
