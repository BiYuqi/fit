import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { toDateOnly } from "../lib/dates";
import { enrichMealCards } from "../services/meal-card";
import type { ChatMessage } from "@prisma/client";

// Enrich card messages with resolved status + resolution details from pendingRecord
async function enrichResolved(messages: ChatMessage[]): Promise<Array<ChatMessage & { payload: unknown }>> {
  const pendingIds = messages
    .filter((m) => ["portion_card", "candidate_card", "clarify_card", "delete_confirm_card"].includes(m.kind))
    .map((m) => (m.payload as any)?.pending_id as string | undefined)
    .filter(Boolean) as string[];

  const resolutionMap = new Map<string, Record<string, unknown>>();
  if (pendingIds.length > 0) {
    const resolved = await prisma.pendingRecord.findMany({
      where: { id: { in: pendingIds }, status: "resolved" },
      select: { id: true, candidates: true },
    });
    for (const p of resolved) {
      const c = p.candidates as any;
      const enrichment: Record<string, unknown> = { resolved: true };
      if (c.resolved_portion) {
        enrichment.resolved_portion = c.resolved_portion;
        enrichment.resolved_grams = c.resolved_grams;
        enrichment.resolved_unit = c.resolved_unit ?? "g";
      }
      resolutionMap.set(p.id, enrichment);
    }
  }

  return messages.map((m) => {
    const pid = (m.payload as any)?.pending_id;
    const enrichment = pid ? resolutionMap.get(pid) : undefined;
    if (enrichment) {
      return { ...m, payload: { ...(m.payload as any), ...enrichment } };
    }
    return m;
  });
}

const DateQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

const DatesQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
});

const RangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function chatHistoryRoutes(app: FastifyInstance) {
  const auth = (req: any, reply: any) => app.authenticate(req, reply);

  // ─────────────────────────────────────────────
  // GET /api/chat/messages?date=YYYY-MM-DD
  // ─────────────────────────────────────────────
  app.get("/api/chat/messages", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const qParsed = DateQuerySchema.safeParse(req.query);
    if (!qParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_params", message: qParsed.error.message } });
    }
    const { date } = qParsed.data;

    const messages = await prisma.chatMessage.findMany({
      where: { user_id, date: toDateOnly(date) },
      orderBy: { created_at: "asc" },
    });

    // T46：meal_card 明细/总计从 food_record 实时组装（payload 落库只有 meal_key）
    const enriched = await enrichMealCards(await enrichResolved(messages));
    return { date, messages: enriched };
  });

  // ─────────────────────────────────────────────
  // GET /api/chat/dates?from=&to=
  // ─────────────────────────────────────────────
  app.get("/api/chat/dates", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const qParsed = DatesQuerySchema.safeParse(req.query);
    if (!qParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_params", message: qParsed.error.message } });
    }
    const { from, to } = qParsed.data;

    const rows = await prisma.chatMessage.groupBy({
      by: ["date"],
      where: {
        user_id,
        date: { gte: toDateOnly(from), lte: toDateOnly(to) },
      },
      orderBy: { date: "asc" },
    });

    const dates = rows.map((r) => r.date.toISOString().slice(0, 10));
    return { dates };
  });

  // ─────────────────────────────────────────────
  // GET /api/chat/messages/range?from=&to=
  // ─────────────────────────────────────────────
  app.get("/api/chat/messages/range", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const qParsed = RangeQuerySchema.safeParse(req.query);
    if (!qParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_params", message: qParsed.error.message } });
    }
    const { from, to } = qParsed.data;

    const messages = await prisma.chatMessage.findMany({
      where: { user_id, date: { gte: toDateOnly(from), lte: toDateOnly(to) } },
      orderBy: { created_at: "asc" },
    });

    const enriched = await enrichMealCards(await enrichResolved(messages));
    return { messages: enriched };
  });
}
