// T38：用户打字回答【待确认】卡片（份量卡/候选卡），而不是点卡。
// 复用 pending-resolve.ts 与卡片点选相同的落地逻辑，唯一区别是日志归口：
// chat.ts 已经为本轮写了一条 ai_parse_log（intent=resolve_pending），这里 skipLog
// 并把 resolve 出的 action 回填进那条日志（intent 改写为 resolve），避免 L0 出现两条重复记录。
import { prisma } from "../../lib/prisma";
import { buildContextCard } from "../summary";
import { resolvePendingRecord, PENDING_STALE_MS } from "../pending-resolve";
import { describeResolveAction } from "../resolve-log";
import type { ParseResult } from "../../ai/schema";
import type { IntentCtx } from "./types";

export async function handleResolvePending(
  parsed: Extract<ParseResult, { intent: "resolve_pending" }>,
  ctx: IntentCtx,
) {
  const { user_id, dateObj, messages, tctx, parseUsage, parseMessages, parseLogId } = ctx;

  const pr = await prisma.pendingRecord.findFirst({
    where: { user_id, status: "pending" },
    orderBy: { created_at: "desc" },
  });
  const expired = pr != null && Date.now() - pr.created_at.getTime() > PENDING_STALE_MS;

  // 防误伤/过期兜底（parser 已按 prompt 规则避免误判，这里是后端最后一道防线）：
  // 没有可 resolve 的卡片时礼貌提示，不硬当新记录也不报错。
  if (!pr || expired) {
    const content = expired
      ? "这张卡片已经过期啦，麻烦重新说一下要记录的内容吧。"
      : "没找到等待确认的卡片，可以再说清楚一点吗？";
    const aiMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "assistant", kind: "text", content },
    });
    messages.push(aiMsg);
    const card = await buildContextCard(user_id);
    tctx.partial("resolve_pending", { tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "resolve_pending", reply: content, summary_card: card, messages };
  }

  const outcome = await resolvePendingRecord({ user_id, pendingId: pr.id, choice: parsed.choice, skipLog: true });

  if (!outcome.ok) {
    const content = "没能处理这个选择，可以换个说法再试试吗？";
    const aiMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "assistant", kind: "text", content },
    });
    messages.push(aiMsg);
    const card = await buildContextCard(user_id);
    tctx.partial("resolve_pending", { tokenUsage: parseUsage, promptMessages: parseMessages });
    return { intent: "resolve_pending", reply: content, summary_card: card, messages };
  }

  messages.push(...outcome.messages);
  // 把 resolve 出的动作回填进 chat.ts 已建的那条日志：intent 改写为 resolve，
  // 复用既有的 L0 渲染（"卡片确认(...)"）与指代锚点抽取（memory.ts 认 intent=resolve）。
  if (parseLogId) {
    await prisma.aiParseLog.update({
      where: { id: parseLogId },
      data: { intent: "resolve", parsed_json: outcome.action as object },
    });
  }

  const reply = describeResolveAction(outcome.action);
  tctx.ok("resolve_pending", { tokenUsage: parseUsage, promptMessages: parseMessages });
  // resolved_pending_id：前端凭这个把聊天流里那张旧卡就地标记已确认，防止用户再点一次（T38）
  return {
    intent: "resolve_pending",
    reply,
    record: outcome.record,
    summary_card: outcome.summary_card,
    messages,
    resolved_pending_id: pr.id,
  };
}
