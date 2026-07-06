import { prisma } from "../../lib/prisma";
import { answerQuery } from "../../ai/answers";
import type { IntentCtx } from "./types";
import { planQuery, executeQueryPlan, fetchWeights, buildWeightCard, type QueryPlan } from "./query-plan";
import type { Prisma } from "@prisma/client";

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

function addUsage(a: Usage, b?: Usage): Usage {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

// query 意图（T44 查询计划架构）：
//   planner（AI 填结构化查询单，flash→pro 重试）→ 执行器（后端白名单只读 SQL）→ answerQuery。
// planner 两级都失败时的兜底 = 无 extraCtx 直接回答，answerQuery 的提示词保证
// 对上下文没覆盖的数据如实说"没有记录/暂时查不到"，不编造（只读红线，T39）。
export async function handleQuery(ctx: IntentCtx) {
  const { text, pack, user_id, dateObj, messages, tctx, parseMessages } = ctx;

  let plan: QueryPlan | null = null;
  let extraCtx: string | undefined;
  let planUsage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  try {
    const p = await planQuery(text, pack, user_id);
    plan = p.plan;
    planUsage = p.usage;
    await tctx.recordQueryPlan({ plan: p.plan, model: p.model, upgraded: p.upgraded });

    // 体重趋势：直接出 weight_chart 卡（后端算结论，不走 answerQuery，铁律1）
    if (p.plan.target === "weight") {
      const w = await fetchWeights(user_id);
      const { content, payload } = buildWeightCard(w);
      const cardMsg = await prisma.chatMessage.create({
        data: {
          user_id,
          date: dateObj,
          role: "assistant",
          kind: "weight_chart",
          content,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      });
      messages.push(cardMsg);
      tctx.ok("query", { tokenUsage: planUsage, promptMessages: parseMessages });
      return { intent: "query", reply: content, summary_card: pack.card, messages };
    }

    extraCtx = await executeQueryPlan(user_id, p.plan);
  } catch (err: any) {
    // planner flash+pro 均失败：记 trace 后走无 extraCtx 兜底，绝不 500
    await tctx.recordQueryPlan({ error: err?.message ?? String(err) });
  }

  const { text: aiText, usage: answerUsage } = await answerQuery(text, pack, user_id, extraCtx);
  // query 回复一律纯文本气泡：AI 文字已自包含（数字都在正文里），不套进度卡
  // （「吃多少」/「吃了啥」意图本就不同，不该套同一顶卡）；今日进度看 Today 页（铁律2 事实源）。
  // summary_card 仍随响应返回，供前端刷新 Today 用。
  const aiMsg = await prisma.chatMessage.create({
    data: {
      user_id,
      date: dateObj,
      role: "assistant",
      kind: "text",
      content: aiText,
    },
  });
  messages.push(aiMsg);
  tctx.ok("query", { tokenUsage: addUsage(planUsage, answerUsage), promptMessages: parseMessages }); // trace 结束：status=ok
  return { intent: "query", reply: aiText, summary_card: pack.card, messages };
}
