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
import { handleResolvePending } from "../services/intents/resolve-pending";
import { handleRecordWeight } from "../services/intents/record-weight";
import type { IntentCtx } from "../services/intents/types";
import { quickExtract, fullExtract, hasMemorySignal } from "../services/memory-extract";
import { isMemoryPaused } from "../services/memory-store";

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

    // ── 语义记忆：同步 constraint 提取（MEMORY_SPEC §4.1，T55）──
    // 关键词命中 → 调 DeepSeek flash 提取 constraint → 写入 user_memory → 本轮立即可用（零窗口期）
    // 必须 await：constraint 写入后才 buildMemoryPack，否则本轮注入不到刚提取的约束
    // 暂停记忆提取时跳过（T56 pause toggle）
    const memoryPaused = await isMemoryPaused(user_id).catch(() => false);
    let medicalDenials: string[] = [];
    if (!memoryPaused && hasMemorySignal(text)) {
      try {
        medicalDenials = (await quickExtract(text, user_id)).medicalDenials;
      } catch (err) {
        console.warn("chat: quickExtract failed", err);
      }
    }

    // 组装对话记忆包（L0 ai_parse_log / L1 今日记录 / L2 画像+卡），注入 prompt 消解指代
    // 此刻本条消息尚未写 ai_parse_log / food_record，记忆包反映的是「本条之前」状态，正合语义
    // 注意：buildMemoryPack 内部调用 loadActiveMemories，会读到上面刚写入的 constraint
    const pack = await buildMemoryPack(user_id);

    // 用户否认了一条医疗类记忆：系统只降权不自动删（T74 口径 3），让 AI 在回复里说清楚
    if (medicalDenials.length > 0) {
      pack.memory_notice = `用户刚刚否认了这条医疗类记忆：「${medicalDenials.join("」「")}」。医疗/过敏类记忆不会自动删除（误删代价太大），请在回复里顺带告诉用户可以去「我的-记忆中心」手动删掉它。`;
    }

    // ── 语义记忆：异步 full 提取（MEMORY_SPEC §4.1，T55）──
    // 响应返回后跑，不阻塞主流程；失败静默；暂停时跳过
    if (!memoryPaused) {
      fullExtract(user_id).catch((err) =>
        console.warn("chat: fullExtract async failed", err),
      );
    }

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
    let needsUpgrade = false;
    try {
      const pr = await parseUserInput(text, pack, "deepseek-v4-flash", user_id);
      parsed = pr.result;
      parseUsage = pr.usage;
      parseMessages = pr.messages as object;
      needsUpgrade = pr.needsUpgrade;
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
      // T67：食物 confidence 会因复合菜丢主料而虚高（"煎鸡胸肉汤面条"→"熟面条"仍给 0.85），
      // needsUpgrade 是不依赖模型自评的确定性校验，与置信度阈值并列触发升级，互不替代。
      const hasLow = needsUpgrade || parsed.items.some((i) => i.food_confidence < 0.5);
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

    // T73 确定性纠偏：判了 modify，但 target 引用的 ref 在【今日已记录】里一个都不存在 →
    // 这条 modify 无论如何都执行不了（handleModify 只会回一句"没找到要修改的那条记录"，用户说的话就白说了）。
    // 典型场景：用户先说"我每天都有30分钟的羽毛球"（习惯陈述，不入库），再说"今天羽毛球是15分钟"——
    // 后一句是当天的新记录，但句式像纠正，模型约一半概率误判 modify。提示词治不住（实测 1/2），
    // 用"ref 不存在"这个可证伪的事实触发一次重解析，比继续堆提示词可靠。
    if (parsed.intent === "modify") {
      const refs = Array.isArray(parsed.target) ? parsed.target : [parsed.target];
      const anyExists = refs.some((ref) => pack.recent_records.some((r) => r.ref === ref));
      if (!anyExists) {
        try {
          const pr = await parseUserInput(
            text, pack, "deepseek-v4-pro", user_id,
            "【重要纠正】上一次解析把这句判成了 modify，但它引用的记录在【今日已记录】里并不存在，"
            + "该判断已被证伪。请在 record 和 chat 之间重新二选一，绝不要再输出 modify：\n"
            + "- 句中出现具体的食物或运动 + 数量/时长（如「今天羽毛球是15分钟」「今天只跑了20分钟」「早上吃了两个蛋」），"
            + "就是用户在陈述自己吃了/做了什么 → **intent=record**，照常填 items / exercise；\n"
            + "- 只有句子里完全没有可记录的进食或运动内容（纯提问、纯闲聊）才输出 chat。",
          );
          parsed = pr.result;
          parseUsage = pr.usage;
          parseMessages = pr.messages as object;
          modelUsed = "deepseek-v4-pro";
        } catch {
          /* 重解析失败：保留原结果，handleModify 会给出"没找到要修改的那条记录"的兜底回复 */
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

    const intentCtx: IntentCtx = { user_id, text, source, today, dateObj, pack, messages, tctx, parseUsage, parseMessages, parseLogId: parseLog.id };

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

    // ── resolve_pending（打字回答【待确认】卡片，T38）──
    if (parsed.intent === "resolve_pending") {
      return await backfillReply(await handleResolvePending(parsed, intentCtx));
    }

    // ── record_weight（上报实测体重，只 append weight_log，不动档案）──
    if (parsed.intent === "record_weight") {
      return await backfillReply(await handleRecordWeight(parsed, intentCtx));
    }

    // ── multi（一条消息多个独立动作，T45）──────────
    // 按用户叙述顺序逐个执行 record/modify，共享 messages 累积卡片；
    // 每个 op 用自己的原文子句当 text（餐次提取/pending raw_input/估算上下文都按子句走，
    // 避免"删了粽子，还吃了无油葱花饼"里后一个动作的修饰词污染前一个）。
    // refs（r1/e1）全部按本条消息开始时的记忆包快照解析，op 之间不重建 pack。
    if (parsed.intent === "multi") {
      const replies: string[] = [];
      let summary_card: object | undefined;
      let pending: object | undefined;
      const records: object[] = [];
      for (const op of parsed.ops) {
        const opCtx: IntentCtx = { ...intentCtx, text: op.raw?.trim() || text };
        const r = op.intent === "record"
          ? await handleRecord(op, opCtx)
          : await handleModify(op, opCtx);
        if (r.reply) replies.push(r.reply);
        if (r.summary_card) summary_card = r.summary_card as object;
        const rr = r as { pending?: object; records?: object[]; record?: object };
        if (rr.pending) pending = rr.pending;
        if (rr.records) records.push(...rr.records);
        else if (rr.record) records.push(rr.record);
      }
      // 各 op 的 handler 内部会各自 finalize trace（last-write-wins），这里收口成 multi
      tctx.ok("multi", { tokenUsage: parseUsage, promptMessages: parseMessages });
      return await backfillReply({
        intent: "multi",
        reply: replies.join("\n"),
        records: records.length ? records : undefined,
        pending,
        summary_card,
        messages,
      });
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
