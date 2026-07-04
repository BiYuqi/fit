import { prisma } from "../../lib/prisma";
import { answerQuery } from "../../ai/answers";
import type { IntentCtx } from "./types";

// 从文本提取目标日期（昨天/前天/N天前/MM月DD日）
function extractQueryDate(text: string): string | null {
  const today = new Date(Date.now() + 8 * 3600 * 1000);
  const todayOnly = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const shift = (n: number) => {
    const d = new Date(todayOnly);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  if (/昨天|昨日/.test(text)) return shift(1);
  if (/前天/.test(text)) return shift(2);
  const nDays = text.match(/(\d+)\s*天前/);
  if (nDays) return shift(parseInt(nDays[1]));
  const md = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (md) {
    const d = new Date(Date.UTC(todayOnly.getUTCFullYear(), parseInt(md[1]) - 1, parseInt(md[2])));
    return d.toISOString().slice(0, 10);
  }
  return null;
}

// 实时查询某天摄入（summary 优先，无则聚合 foodRecord）
async function fetchDayData(user_id: string, dateStr: string) {
  const dateObj = new Date(dateStr + "T00:00:00.000Z");
  const s = await prisma.dailySummary.findUnique({
    where: { user_id_date: { user_id, date: dateObj } },
  });
  if (s) {
    return `${dateStr} 摄入${Math.round(s.calories_in)}kcal 蛋白${Math.round(s.protein)}g 脂肪${Math.round(s.fat)}g 碳水${Math.round(s.carbs)}g`;
  }
  const agg = await prisma.foodRecord.aggregate({
    where: { user_id, date: dateObj },
    _sum: { calories: true, protein: true, fat: true, carbs: true },
  });
  const total = Math.round(agg._sum.calories ?? 0);
  if (total === 0) return null;
  return `${dateStr} 摄入${total}kcal 蛋白${Math.round(agg._sum.protein ?? 0)}g 脂肪${Math.round(agg._sum.fat ?? 0)}g 碳水${Math.round(agg._sum.carbs ?? 0)}g`;
}

// 某天的逐条食物/运动明细（区别于 fetchDayData 的总量聚合）——
// 历史日期落在 recent_days（近3天聚合，见 memory.ts）范围内时只有总量没有明细，
// "具体吃了什么"这类问题原本无从回答，只能如实说"没有更细的数据"。
async function fetchDayItems(user_id: string, dateStr: string): Promise<string | null> {
  const dateObj = new Date(dateStr + "T00:00:00.000Z");
  const [foods, exercises] = await Promise.all([
    prisma.foodRecord.findMany({
      where: { user_id, date: dateObj },
      include: { food: true },
      orderBy: { created_at: "asc" },
    }),
    prisma.exerciseRecord.findMany({
      where: { user_id, date: dateObj },
      orderBy: { created_at: "asc" },
    }),
  ]);
  if (foods.length === 0 && exercises.length === 0) return null;
  const parts = [
    ...foods.map((f) => `${f.food?.name ?? f.raw_input ?? "未知食物"} ${Math.round(f.weight_g)}g(约${Math.round(f.calories)}kcal)`),
    ...exercises.map((e) => `${e.type}${e.duration_min ? `${e.duration_min}分钟` : ""}(消耗${Math.round(e.calories_burned)}kcal)`),
  ];
  return `${dateStr} 明细：${parts.join("、")}`;
}

// 跟进细问（"具体吃了什么"类）本身不带日期词，日期要从上一轮 query 意图的原话里找——
// 不读 chat_message（铁律3），只读 ai_parse_log 来的 L0（pack.recent_turns），且只取日期，不取内容当事实。
const DETAIL_FOLLOWUP = /具体|明细|清单|列一下|都吃|哪些|细说/;
function resolveQueryDate(text: string, recentTurns: { said: string; intent: string | null }[]): string | null {
  const direct = extractQueryDate(text);
  if (direct) return direct;
  if (!DETAIL_FOLLOWUP.test(text)) return null;
  const lastQuery = [...recentTurns].reverse().find((t) => t.intent === "query");
  return lastQuery ? extractQueryDate(lastQuery.said) : null;
}

export async function handleQuery(ctx: IntentCtx) {
  const { text, pack, user_id, today, dateObj, messages, tctx, parseMessages } = ctx;

  // 若问的是上下文之外的历史日期，实时查 DB 补充；跟进细问没带日期词时从上一轮 query 原话找日期
  let extraCtx: string | undefined;
  const queryDate = resolveQueryDate(text, pack.recent_turns);
  if (queryDate && queryDate !== today) {
    const parts: string[] = [];
    // recent_days（近3天聚合）已覆盖总量的日期不用再查总量，但从不含逐条明细，明细总要查
    const inContext = pack.recent_days.some((d) => d.date === queryDate);
    if (!inContext) {
      const row = await fetchDayData(user_id, queryDate);
      if (row) parts.push(row);
    }
    const items = await fetchDayItems(user_id, queryDate);
    if (items) parts.push(items);
    if (parts.length > 0) extraCtx = `【实时查询】${parts.join("；")}`;
  }
  const { text: aiText, usage: queryUsage } = await answerQuery(text, pack, user_id, extraCtx);
  // 只有明确问今天的问题才展示 query_card 卡片；问历史的用纯文本气泡
  const isTodayQuery = /今天|今日|现在|还可以|剩余|还剩/.test(text);
  const aiMsg = await prisma.chatMessage.create({
    data: {
      user_id,
      date: dateObj,
      role: "assistant",
      kind: isTodayQuery ? "query_card" : "text",
      content: aiText,
      payload: isTodayQuery ? (pack.card as object) : undefined,
    },
  });
  messages.push(aiMsg);
  tctx.ok("query", { tokenUsage: queryUsage, promptMessages: parseMessages }); // trace 结束：status=ok
  return { intent: "query", reply: aiText, summary_card: pack.card, messages };
}
