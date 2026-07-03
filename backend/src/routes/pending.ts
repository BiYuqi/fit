import { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolvePendingRecord, type ResolveChoice } from "../services/pending-resolve";

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

    const outcome = await resolvePendingRecord({ user_id, pendingId: id, choice: choice as ResolveChoice });
    if (!outcome.ok) {
      if (outcome.reason === "not_found") {
        return reply.status(404).send({ error: { code: "not_found", message: "Pending record not found or already resolved" } });
      }
      return reply.status(400).send({ error: { code: "invalid_food", message: "Food not found" } });
    }

    return { record: outcome.record, summary_card: outcome.summary_card, messages: outcome.messages };
  });
}
