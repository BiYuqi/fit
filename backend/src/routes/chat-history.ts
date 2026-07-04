import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { toDateOnly } from "../lib/dates";
import { enrichMealCards, refreshMealCard } from "../services/meal-card";
import { recompute, buildContextCard } from "../services/summary";
import type { DeleteSnapshot } from "../services/delete-record";
import type { ChatMessage, MealType, PortionLabel } from "@prisma/client";

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

  // ─────────────────────────────────────────────
  // POST /api/chat/events/:message_id/undo —— T49：删除事件行「撤销」，按快照重建记录（新 id）
  // ─────────────────────────────────────────────
  app.post("/api/chat/events/:message_id/undo", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const { message_id } = req.params as { message_id: string };

    const msg = await prisma.chatMessage.findFirst({ where: { id: message_id, user_id, kind: "event" } });
    if (!msg) {
      return reply.status(404).send({ error: { code: "not_found", message: "Event message not found" } });
    }

    const payload = msg.payload as any;

    // 幂等：已撤销过直接返回当前状态，不重复重建记录——必须先判 undone 再看 undo，
    // 因为撤销成功后 undo 会被清成 null，此时 prevState 判断会先于幂等短路误报 400
    if (payload?.undone) {
      const summary_card = await buildContextCard(user_id);
      return { ok: true, summary_card, messages: [msg] };
    }

    const prevState = payload?.undo?.prev_state as DeleteSnapshot | undefined;
    if (!prevState) {
      return reply.status(400).send({ error: { code: "no_undo", message: "This event has nothing to undo" } });
    }

    const messages: ChatMessage[] = [];
    let summary_card;

    if (prevState.kind === "exercise") {
      await prisma.exerciseRecord.create({
        data: {
          user_id,
          type: prevState.type,
          duration_min: prevState.duration_min,
          calories_burned: prevState.calories_burned,
          source: prevState.source,
          raw_input: prevState.raw_input,
          date: toDateOnly(prevState.date),
        },
      });
      await recompute(user_id, prevState.date);
      summary_card = await buildContextCard(user_id);
    } else {
      await prisma.foodRecord.create({
        data: {
          user_id,
          food_id: prevState.food_id,
          meal_type: prevState.meal_type as MealType,
          portion_label: prevState.portion_label as PortionLabel,
          weight_g: prevState.weight_g,
          calories: prevState.calories,
          protein: prevState.protein,
          fat: prevState.fat,
          carbs: prevState.carbs,
          food_confidence: prevState.food_confidence,
          portion_confidence: prevState.portion_confidence,
          source: prevState.source,
          raw_input: prevState.raw_input,
          alias_canonical: prevState.alias_canonical,
          predicted_grams: prevState.predicted_grams,
          scene: prevState.scene,
          calories_source: prevState.calories_source,
          date: toDateOnly(prevState.date),
        },
      });
      await recompute(user_id, prevState.date);
      summary_card = await buildContextCard(user_id);
      // 恢复后该餐卡多一项；卡不存在（删的是该餐最后一项且卡本身也没了？不会——meal_card 删空只清空不删卡）
      // 仍兜底 createIfMissing，避免极端情况下卡缺失
      await refreshMealCard(messages, {
        user_id, mealDate: prevState.date, meal_type: prevState.meal_type as MealType,
        chatDate: msg.date,
      });
    }

    const updated = await prisma.chatMessage.update({
      where: { id: message_id },
      data: { payload: { ...payload, undone: true, undo: null } as object },
    });
    messages.push(updated);

    return { ok: true, summary_card, messages };
  });
}
