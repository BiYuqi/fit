import { prisma } from "../../lib/prisma";
import { toDateOnly } from "../../lib/dates";
import type { ParseResult } from "../../ai/schema";
import type { IntentCtx } from "./types";

// record_weight 意图（LEARNING_SPEC §8）：用户口头上报当日实测体重。
//   只 append 一个 weight_log 历史点（同一天多次覆盖当天那行），
//   **绝不触碰 User.weight_kg（初始体重）/ target_weight_kg（目标体重）**——
//   这正是用户要的"你只负责记录，不用改我的初始体重"。
//
// 与设置页那条 upsertWeightLog（fire-and-forget、静默失败）不同：这里是用户显式指令，
// 写入必须 awaited、失败要抛（由 chat.ts catch 转成诚实报错），绝不能"说存了其实没存"。
function fmt(kg: number): string {
  // 去掉多余小数尾零：77.75→77.75，78.0→78
  return Number(kg.toFixed(2)).toString();
}

export async function handleRecordWeight(
  parsed: Extract<ParseResult, { intent: "record_weight" }>,
  ctx: IntentCtx,
) {
  const { user_id, today, dateObj, messages, tctx, parseUsage, parseMessages } = ctx;
  const date = toDateOnly(today);
  const weight_kg = parsed.weight_kg;

  // 取「初始体重」与「上一个体重点」用于回执里的趋势（都只读，不改）
  const [user, prevLog] = await Promise.all([
    prisma.user.findUnique({ where: { id: user_id }, select: { weight_kg: true } }),
    prisma.weightLog.findFirst({
      where: { user_id, date: { lt: date } },
      orderBy: { date: "desc" },
      select: { weight_kg: true },
    }),
  ]);

  await prisma.weightLog.upsert({
    where: { user_id_date: { user_id, date } },
    update: { weight_kg },
    create: { user_id, date, weight_kg },
  });

  // 回执：确认已记 + 相对上一次实测点（无则相对初始体重）的变化，让用户看到趋势
  const baseline = prevLog?.weight_kg != null ? Number(prevLog.weight_kg) : (user?.weight_kg != null ? Number(user.weight_kg) : null);
  const baselineLabel = prevLog?.weight_kg != null ? "上次" : "起点";
  let trend = "";
  if (baseline != null) {
    const delta = weight_kg - baseline;
    const absStr = fmt(Math.abs(delta));
    if (Math.abs(delta) < 0.05) trend = `，和${baselineLabel}持平`;
    else if (delta < 0) trend = `，比${baselineLabel}${fmt(baseline)}kg 少了 ${absStr}kg`;
    else trend = `，比${baselineLabel}${fmt(baseline)}kg 多了 ${absStr}kg`;
  }
  const reply = `已记录今天体重 ${fmt(weight_kg)}kg${trend}。（初始体重和目标没动，只是留了个实测点看趋势）`;

  const aiMsg = await prisma.chatMessage.create({
    data: { user_id, date: dateObj, role: "assistant", kind: "text", content: reply },
  });
  messages.push(aiMsg);

  tctx.ok("record_weight", { tokenUsage: parseUsage, promptMessages: parseMessages });
  return { intent: "record_weight", reply, messages };
}
