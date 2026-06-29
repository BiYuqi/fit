import { prisma } from "../lib/prisma";
import { bmr as calcBmr, tdee as calcTdee, dailyTargets } from "./calc";
import type { UserProfile, Sex, ActivityLevel } from "./calc";

export interface ContextCard {
  today: { in: number; out: number; deficit: number; p: number; f: number; c: number; remaining: number };
  yesterday: { in: number; deficit: number; p: number; f: number; c: number };
  week: { avg_deficit: number; logged_days: number };
  month: { logged_days: number; avg_in: number };
  targets: { calories: number; protein: number };
}

// date string "YYYY-MM-DD" → UTC midnight Date（@db.Date 字段匹配用）
function toDateOnly(date: Date | string): Date {
  const s = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  return new Date(s + "T00:00:00.000Z");
}

function todayStr(): string {
  const local = new Date(Date.now() + 8 * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

// ---------- recompute ----------

export async function recompute(user_id: string, date: Date | string): Promise<void> {
  const day = toDateOnly(date);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: user_id } });

  // 聚合当日饮食
  const foodAgg = await prisma.foodRecord.aggregate({
    where: { user_id, date: day },
    _sum: { calories: true, protein: true, fat: true, carbs: true },
  });

  // 聚合当日运动
  const exAgg = await prisma.exerciseRecord.aggregate({
    where: { user_id, date: day },
    _sum: { calories_burned: true },
  });

  // 只有档案完整时才能算 TDEE
  let bmrVal = 0, tdeeVal = 0, target_calories = 0, target_protein = 0;
  if (user.gender && user.age != null && user.height_cm && user.weight_kg && user.activity_level) {
    const profile: UserProfile = {
      sex: user.gender as Sex,
      age: user.age,
      height_cm: Number(user.height_cm),
      weight_kg: Number(user.weight_kg),
      activity_level: user.activity_level as ActivityLevel,
      daily_deficit: user.daily_deficit,
    };
    bmrVal = calcBmr(profile);
    tdeeVal = calcTdee(profile);
    const t = dailyTargets(profile);
    target_calories = t.target_calories;
    target_protein = t.target_protein_g;
  }

  const calories_in  = foodAgg._sum.calories ?? 0;
  const protein      = foodAgg._sum.protein  ?? 0;
  const fat          = foodAgg._sum.fat      ?? 0;
  const carbs        = foodAgg._sum.carbs    ?? 0;
  const exercise_out = exAgg._sum.calories_burned ?? 0;
  const total_out    = tdeeVal + exercise_out;
  const deficit      = total_out - calories_in;

  const row = {
    calories_in, bmr: bmrVal, tdee: tdeeVal,
    exercise_out, total_out, deficit,
    protein, fat, carbs,
    target_calories, target_protein,
  };

  await prisma.dailySummary.upsert({
    where: { user_id_date: { user_id, date: day } },
    create: { user_id, date: day, ...row },
    update: row,
  });
}

// ---------- buildContextCard ----------

export async function buildContextCard(user_id: string): Promise<ContextCard> {
  const today = toDateOnly(todayStr());

  const weekAgo = new Date(today);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 6); // 含今天共7天

  const monthAgo = new Date(today);
  monthAgo.setUTCDate(monthAgo.getUTCDate() - 29); // 含今天共30天

  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const [todaySummary, yesterdaySummary, weekRows, monthRows] = await Promise.all([
    prisma.dailySummary.findUnique({ where: { user_id_date: { user_id, date: today } } }),
    prisma.dailySummary.findUnique({ where: { user_id_date: { user_id, date: yesterday } } }),
    prisma.dailySummary.findMany({ where: { user_id, date: { gte: weekAgo, lte: today } } }),
    prisma.dailySummary.findMany({ where: { user_id, date: { gte: monthAgo, lte: today } } }),
  ]);

  const cal_in       = todaySummary?.calories_in   ?? 0;
  const total_out    = todaySummary?.total_out      ?? 0;
  const deficit      = todaySummary?.deficit        ?? 0;
  const target_cal   = todaySummary?.target_calories ?? 0;
  const target_prot  = todaySummary?.target_protein  ?? 0;

  const weekLogged  = weekRows.filter(r => r.calories_in > 0).length;
  const monthLogged = monthRows.filter(r => r.calories_in > 0).length;

  const avg_deficit = weekLogged > 0
    ? Math.round(weekRows.reduce((s, r) => s + r.deficit, 0) / weekLogged)
    : 0;
  const avg_in = monthLogged > 0
    ? Math.round(monthRows.reduce((s, r) => s + r.calories_in, 0) / monthLogged)
    : 0;

  return {
    today: {
      in:        Math.round(cal_in),
      out:       Math.round(total_out),
      deficit:   Math.round(deficit),
      p:         Math.round(todaySummary?.protein ?? 0),
      f:         Math.round(todaySummary?.fat ?? 0),
      c:         Math.round(todaySummary?.carbs ?? 0),
      remaining: Math.round(target_cal - cal_in),
    },
    yesterday: {
      in:      Math.round(yesterdaySummary?.calories_in ?? 0),
      deficit: Math.round(yesterdaySummary?.deficit ?? 0),
      p:       Math.round(yesterdaySummary?.protein ?? 0),
      f:       Math.round(yesterdaySummary?.fat ?? 0),
      c:       Math.round(yesterdaySummary?.carbs ?? 0),
    },
    week:    { avg_deficit, logged_days: weekLogged },
    month:   { logged_days: monthLogged, avg_in },
    targets: { calories: Math.round(target_cal), protein: Math.round(target_prot) },
  };
}
