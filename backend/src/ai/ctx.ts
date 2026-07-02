import { callDeepSeek, type ChatMessage, type CallOptions } from "./client";
import type { MemoryPack } from "../services/memory";

const RECORD_LIMIT = 20;
const TURN_LIMIT = 5;

const MEAL_ZH: Record<string, string> = {
  breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐",
};
const PORTION_ZH: Record<string, string> = {
  small: "小份", medium: "中份", large: "大份", custom: "自定",
};

function todayStrCtx(): string {
  const local = new Date(Date.now() + 8 * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

export function compressContext(pack: MemoryPack): string {
  const { profile: p, card, recent_records, recent_turns, recent_days } = pack;
  const lines: string[] = [];

  // 日期锚点：让 AI 知道"今天/昨天/前天"对应的实际日期
  lines.push(`【当前日期】今天是 ${todayStrCtx()}（北京时间）`);

  // L2 画像 + 今日进度
  const prof: string[] = [];
  if (p.gender) prof.push(p.gender === "male" ? "男" : "女");
  if (p.age != null) prof.push(`${p.age}岁`);
  if (p.height_cm != null) prof.push(`身高${p.height_cm}`);
  if (p.weight_kg != null) prof.push(`体重${p.weight_kg}`);
  if (p.target_weight_kg != null) prof.push(`目标体重${p.target_weight_kg}`);
  prof.push(p.goal_type === "cut" ? "目标减脂" : "目标维持");
  if (p.daily_deficit) prof.push(`目标缺口${p.daily_deficit}`);
  lines.push(`【用户档案】${prof.join(" ")}`);
  lines.push(
    `【今日进度】摄入${card.today.in}kcal 总消耗${card.today.out}kcal 实际缺口${card.today.deficit}kcal 目标摄入${card.targets.calories}kcal 还可吃${card.today.remaining}kcal 蛋白${card.today.p}/${card.targets.protein}g`
  );
  // 近3天每日明细（有记录的天才输出）
  if (recent_days.length > 0) {
    lines.push("【近3日每日摄入】");
    for (const d of recent_days) {
      lines.push(`  ${d.date} 摄入${d.in}kcal 蛋白${d.p}g 脂肪${d.f}g 碳水${d.c}g`);
    }
  }

  // L1 今日已记录（超过 RECORD_LIMIT 条则折叠更早的）
  const total = recent_records.length;
  const shown = recent_records.slice(-RECORD_LIMIT);
  const hidden = total - shown.length;
  if (total > 0) {
    lines.push(`【今日已记录】(共${total}条)`);
    if (hidden > 0) lines.push(`  (另有${hidden}条更早记录已折叠)`);
    for (const r of shown) {
      if (r.kind === "food") {
        lines.push(
          `  ${r.ref} ${MEAL_ZH[r.meal_type ?? ""] ?? ""}·${r.name} ${PORTION_ZH[r.portion ?? ""] ?? ""} ${r.weight_g}g ${r.calories}kcal [id=${r.record_id}]`
        );
      } else {
        lines.push(
          `  ${r.ref} 运动·${r.name} ${r.duration_min ?? "?"}min 消耗${r.calories}kcal [id=${r.record_id}]`
        );
      }
    }
  }

  // L0 最近 TURN_LIMIT 轮对话（旧→新，去噪留链）
  const turns = recent_turns.slice(-TURN_LIMIT);
  if (turns.length > 0) {
    lines.push("【最近对话】(旧→新)");
    for (const t of turns) {
      const act =
        t.intent === "record"
          ? `记录(${(t.foods ?? []).map((f) => `${f.name}/${f.portion}`).join("、")})`
          : t.intent === "query"   ? "查询"
          : t.intent === "modify"  ? "修改记录"
          : t.intent === "discuss" ? "质疑/追问记录"
          : "闲聊/咨询";
      lines.push(`  用户:"${t.said}" → ${act}`);
    }
  }

  return lines.join("\n");
}

// 统一 AI 调用入口：强制在第一条 user message 之前注入压缩上下文。
// 所有需要用户上下文的 AI 调用（parser/answerChat/answerQuery/discuss 等）必须走这里。
// 纯食物知识类调用（estimateByAI/adjudicateByAI）不涉及用户状态，继续用 callDeepSeek。
export async function callDeepSeekCtx(
  pack: MemoryPack,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<{ res: Awaited<ReturnType<typeof callDeepSeek>>; messages: ChatMessage[] }> {
  const ctx = compressContext(pack);
  const ctxMsg: ChatMessage = { role: "system", content: `以下是当前对话上下文：\n${ctx}` };

  const insertIdx = messages.findIndex((m) => m.role === "user");
  const fullMessages: ChatMessage[] =
    insertIdx === -1
      ? [...messages, ctxMsg]
      : [...messages.slice(0, insertIdx), ctxMsg, ...messages.slice(insertIdx)];

  const res = await callDeepSeek(fullMessages, opts);
  return { res, messages: fullMessages };
}
