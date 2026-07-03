import { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseUserInput, SYSTEM_PROMPT } from "../services/parser";
import { buildMemoryPack } from "../services/memory";
import type { ParseResult } from "../ai/schema";
import { prisma } from "../lib/prisma";
import { ChatTrace } from "../services/trace";
import { todayStr, toDateOnly } from "../lib/dates";
import { answerChat, answerDiscuss } from "../ai/answers";
import { truncateText } from "../ai/ctx";
import { handleQuery } from "../services/intents/query";
import { handleModify } from "../services/intents/modify";
import { handleRecord } from "../services/intents/record";
import type { IntentCtx } from "../services/intents/types";

// ---------- 请求 schema ----------
const MessageBodySchema = z.object({
  text: z.string().min(1).max(2000),
  source: z.enum(["text", "voice"]).default("text"),
  session_id: z.string().uuid().optional(),
});

// ---------- 路由 ----------
export async function chatRoutes(app: FastifyInstance) {
  const auth = (req: any, reply: any) => app.authenticate(req, reply);

  // ─────────────────────────────────────────────
  // POST /api/chat/message
  // ─────────────────────────────────────────────
  app.post("/api/chat/message", { preHandler: [auth] }, async (req, reply) => {
    const bodyParsed = MessageBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: bodyParsed.error.message } });
    }
    const { text, source, session_id } = bodyParsed.data;
    const { sub: user_id } = req.user as { sub: string };

    const today = todayStr();
    const dateObj = toDateOnly(today);
    const messages: object[] = [];

    // 写用户气泡
    const userMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "user", kind: "text", content: text },
    });
    messages.push(userMsg);

    // 组装对话记忆包（L0 ai_parse_log / L1 今日记录 / L2 画像+卡），注入 prompt 消解指代
    // 此刻本条消息尚未写 ai_parse_log / food_record，记忆包反映的是「本条之前」状态，正合语义
    const pack = await buildMemoryPack(user_id);

    // ─────────────────────────────────────────
    // Trace：创建执行链路（AI_TRACE=disabled 时 traceId=""，所有操作静默跳过）
    // ─────────────────────────────────────────
    const tctx = await ChatTrace.begin(user_id, text, pack, { sessionId: session_id, promptText: SYSTEM_PROMPT });

    let resolvedIntent: string | undefined;
    let parseMessages: object | undefined;
    try {
    // 解析意图（flash → pro 若 zod 校验失败或低置信）
    let parsed: ParseResult;
    let parseUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    let upgraded = false;
    let modelUsed = "deepseek-v4-flash";
    try {
      const pr = await parseUserInput(text, pack, "deepseek-v4-flash", user_id);
      parsed = pr.result;
      parseUsage = pr.usage;
      parseMessages = pr.messages as object;
    } catch {
      // flash 解析失败（zod 校验 / tool call JSON 解析失败），升 pro 重试
      modelUsed = "deepseek-v4-pro";
      try {
        const pr = await parseUserInput(text, pack, "deepseek-v4-pro", user_id);
        parsed = pr.result;
        parseUsage = pr.usage;
        parseMessages = pr.messages as object;
        upgraded = true;
      } catch {
        // pro 也失败，兜底为 chat
        parsed = { intent: "chat" } as ParseResult;
        parseUsage = undefined;
      }
    }
    if (!upgraded && parsed.intent === "record" && parsed.items && parsed.items.length > 0) {
      const hasLow = parsed.items.some((i) => i.food_confidence < 0.5);
      if (hasLow) {
        modelUsed = "deepseek-v4-pro";
        try {
          const pr = await parseUserInput(text, pack, "deepseek-v4-pro", user_id);
          parsed = pr.result;
          parseUsage = pr.usage;
          parseMessages = pr.messages as object;
        } catch {
          /* 保留 flash 结果（含 flash 的 usage） */
        }
      }
    }

    // 写解析日志
    const parseLog = await prisma.aiParseLog.create({
      data: {
        user_id,
        input_text: text,
        parsed_json: parsed as object,
        intent: parsed.intent,
        status: parsed.intent === "record" ? "auto" : "resolved",
      },
    });

    // T37 双向记忆：回复生成后回填本轮 reply_summary（模板回复本身已是摘要，
    // 自由回复截断 ~150 字；不额外调 AI 做摘要）。所有意图分支的返回值都带 reply，统一在此收口。
    const backfillReply = async <T extends { reply?: string | null }>(result: T): Promise<T> => {
      if (result.reply) {
        await prisma.aiParseLog.update({
          where: { id: parseLog.id },
          data: { reply_summary: truncateText(result.reply, 150) },
        });
      }
      return result;
    };

    // Trace: 记录 parse event（DeepSeek 返回 → 写入 ai_trace_event）
    await tctx.recordParse(parsed, modelUsed, upgraded);
    resolvedIntent = parsed.intent;

    const intentCtx: IntentCtx = { user_id, text, source, today, dateObj, pack, messages, tctx, parseUsage, parseMessages };

    // ── query ──────────────────────────────────
    if (parsed.intent === "query") {
      return await backfillReply(await handleQuery(intentCtx));
    }

    // ── chat ───────────────────────────────────
    if (parsed.intent === "chat") {
      const { text: aiText, usage: chatUsage } = await answerChat(text, pack, user_id);
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: aiText },
      });
      messages.push(aiMsg);
      tctx.ok("chat", { tokenUsage: chatUsage, promptMessages: parseMessages });
      return await backfillReply({ intent: "chat", reply: aiText, summary_card: pack.card, messages });
    }

    // ── discuss（针对某条记录提问/质疑，不动数据）─────
    if (parsed.intent === "discuss") {
      const target = pack.recent_records.find((r) => r.ref === parsed.target);
      let aiText: string;
      let discussUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      if (!target) {
        const r = await answerChat(text, pack, user_id);
        aiText = r.text;
        discussUsage = r.usage;
      } else {
        const fullRecord = target.kind === "food"
          ? await prisma.foodRecord.findFirst({
              where: { id: target.record_id, user_id },
              include: { food: true },
            })
          : null;
        const r = await answerDiscuss(text, target, fullRecord as any, pack, user_id);
        aiText = r.text;
        discussUsage = r.usage;
      }
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: aiText },
      });
      messages.push(aiMsg);
      tctx.ok("discuss", { tokenUsage: discussUsage, promptMessages: parseMessages });
      return await backfillReply({ intent: "discuss", reply: aiText, summary_card: pack.card, messages });
    }

    // ── modify（改 / 删 / 追加，AI_PARSING_SPEC §8）──
    if (parsed.intent === "modify") {
      return await backfillReply(await handleModify(parsed, intentCtx));
    }

    // ── record ─────────────────────────────────
    return await backfillReply(await handleRecord(parsed, intentCtx));
  } catch (err: any) {
    // 异常路径也要关闭 trace，避免留下 status="started" 的僵尸记录
    tctx.fail(resolvedIntent ?? "unknown", { message: err?.message }, { promptMessages: parseMessages });
    throw err;
  }
  });
}
