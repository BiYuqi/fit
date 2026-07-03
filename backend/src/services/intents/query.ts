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

export async function handleQuery(ctx: IntentCtx) {
  const { text, pack, user_id, today, dateObj, messages, tctx, parseMessages } = ctx;

  // 若问的是上下文之外的历史日期，实时查 DB 补充
  let extraCtx: string | undefined;
  const queryDate = extractQueryDate(text);
  if (queryDate && queryDate !== today) {
    const inContext = pack.recent_days.some((d) => d.date === queryDate);
    if (!inContext) {
      const row = await fetchDayData(user_id, queryDate);
      if (row) extraCtx = `【实时查询】${row}`;
    }
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
