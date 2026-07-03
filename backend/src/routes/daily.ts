import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { computeUserTargets } from "../services/summary";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function toDateOnly(date: string): Date {
  return new Date(date + "T00:00:00.000Z");
}

function dateToStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getPeriodKey(date: Date, granularity: "day" | "week" | "month"): string {
  if (granularity === "week") return getISOWeek(date);
  if (granularity === "month") return dateToStr(date).slice(0, 7);
  return dateToStr(date);
}

// 零记录新一天的兜底 summary：daily_summary 无行时（recompute 从未跑过），
// Today 页仍要看到基于档案实时算出的目标，而不是"目标 0"。
function buildEmptyDaySummary(user: Parameters<typeof computeUserTargets>[0]) {
  const targets = computeUserTargets(user);
  return {
    ...targets,
    total_out: targets.tdee,
    deficit: targets.tdee,
    calories_in: 0,
    exercise_out: 0,
    protein: 0,
    fat: 0,
    carbs: 0,
  };
}

const RangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  granularity: z.enum(["day", "week", "month"]).default("day"),
});

export async function dailyRoutes(app: FastifyInstance) {
  const auth = (req: any, reply: any) => app.authenticate(req, reply);

  // ─────────────────────────────────────────────
  // GET /api/daily/today
  // ─────────────────────────────────────────────
  app.get("/api/daily/today", { preHandler: [auth] }, async (req) => {
    const { sub: user_id } = req.user as { sub: string };
    const dateObj = toDateOnly(todayStr());

    const [summaryRow, records, exercises] = await Promise.all([
      prisma.dailySummary.findFirst({ where: { user_id, date: dateObj } }),
      prisma.foodRecord.findMany({
        where: { user_id, date: dateObj },
        orderBy: { created_at: "asc" },
      }),
      prisma.exerciseRecord.findMany({
        where: { user_id, date: dateObj },
        orderBy: { created_at: "asc" },
      }),
    ]);

    // 今天还没有任何记录时 recompute 从未跑过，daily_summary 无行——
    // 兜底从档案实时算目标，不能让 Today 页在新的一天开始时显示"目标 0"（见 summary.ts computeUserTargets）。
    let summary = summaryRow as typeof summaryRow | ReturnType<typeof buildEmptyDaySummary>;
    if (!summary) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: user_id } });
      summary = buildEmptyDaySummary(user);
    }

    return { summary, records, exercises };
  });

  // ─────────────────────────────────────────────
  // GET /api/daily/range?from=&to=&granularity=day|week|month
  // ─────────────────────────────────────────────
  app.get("/api/daily/range", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const qParsed = RangeQuerySchema.safeParse(req.query);
    if (!qParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_params", message: qParsed.error.message } });
    }
    const { from, to, granularity } = qParsed.data;

    const summaries = await prisma.dailySummary.findMany({
      where: {
        user_id,
        date: { gte: toDateOnly(from), lte: toDateOnly(to) },
      },
      orderBy: { date: "asc" },
    });

    if (granularity === "day") {
      return summaries.map((s) => ({
        period: dateToStr(s.date),
        calories_in: s.calories_in,
        total_out: s.total_out,
        deficit: s.deficit,
        protein: s.protein,
        fat: s.fat,
        carbs: s.carbs,
      }));
    }

    // Aggregate into week / month buckets
    type Bucket = { calories_in: number; total_out: number; deficit: number; protein: number; fat: number; carbs: number };
    const groups = new Map<string, Bucket>();
    for (const s of summaries) {
      const key = getPeriodKey(s.date, granularity);
      const g = groups.get(key) ?? { calories_in: 0, total_out: 0, deficit: 0, protein: 0, fat: 0, carbs: 0 };
      g.calories_in += s.calories_in;
      g.total_out += s.total_out;
      g.deficit += s.deficit;
      g.protein += s.protein;
      g.fat += s.fat;
      g.carbs += s.carbs;
      groups.set(key, g);
    }

    return Array.from(groups.entries()).map(([period, g]) => ({ period, ...g }));
  });

  // ─────────────────────────────────────────────
  // GET /api/daily/records?from=&to=
  // ─────────────────────────────────────────────
  app.get("/api/daily/records", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const qParsed = RangeQuerySchema.safeParse(req.query);
    if (!qParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_params", message: qParsed.error.message } });
    }
    const { from, to } = qParsed.data;

    const [records, exercises] = await Promise.all([
      prisma.foodRecord.findMany({
        where: { user_id, date: { gte: toDateOnly(from), lte: toDateOnly(to) } },
        include: { food: true },
        orderBy: [{ date: "asc" }, { created_at: "asc" }],
      }),
      prisma.exerciseRecord.findMany({
        where: { user_id, date: { gte: toDateOnly(from), lte: toDateOnly(to) } },
        orderBy: [{ date: "asc" }, { created_at: "asc" }],
      }),
    ]);

    return { records, exercises };
  });
}
