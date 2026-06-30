import { prisma } from "../lib/prisma";
import { buildContextCard, type ContextCard } from "./summary";

// ─────────────────────────────────────────────
// 对话记忆包（AI_PARSING_SPEC §7）
// 喂 AI 的三层上下文，让无状态 API 不丢上下文：
//   L2 画像·永久   profile + 上下文卡
//   L1 工作记忆·今天 recent_records（今天每条记录的当前值快照 + ref）
//   L0 对话窗口·最近 recent_turns（最近 6~8 轮「用户话 + AI 动作」，滑动窗口）
// 铁律 3：对话记忆只从 ai_parse_log / 事实表取，绝不读 chat_message。
// ─────────────────────────────────────────────

const TURN_WINDOW = 8; // L0 滑动窗口：最近 N 轮

function todayStr(): string {
  const local = new Date(Date.now() + 8 * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

function toDateOnly(date: string): Date {
  return new Date(date + "T00:00:00.000Z");
}

const MEAL_ZH: Record<string, string> = {
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  snack: "加餐",
};
const PORTION_ZH: Record<string, string> = {
  small: "小份",
  medium: "中份",
  large: "大份",
  custom: "自定",
};

export interface MemoryProfile {
  gender: string | null;
  age: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  target_weight_kg: number | null;
  goal_type: string;
  daily_deficit: number;
  activity_level: string | null;
}

export interface RecordRef {
  ref: string;           // r1/r2…（食物）, e1/e2…（运动）— 供 L0 与 modify(target) 引用
  record_id: string;
  kind: "food" | "exercise";
  name: string;
  meal_type?: string;
  portion?: string;
  weight_g?: number;
  calories: number;
  duration_min?: number;
}

export interface TurnSummary {
  said: string;                                  // 用户原话（来自 ai_parse_log.input_text）
  intent: string | null;                         // record / query / chat
  foods?: Array<{ name: string; portion: string }>; // record 意图时的动作锚点
}

export interface MemoryPack {
  profile: MemoryProfile;
  card: ContextCard;
  recent_records: RecordRef[];
  recent_turns: TurnSummary[];
}

export async function buildMemoryPack(user_id: string): Promise<MemoryPack> {
  const today = toDateOnly(todayStr());

  const [user, card, foods, exercises, logs] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: user_id } }),
    buildContextCard(user_id),
    prisma.foodRecord.findMany({
      where: { user_id, date: today },
      include: { food: true },
      orderBy: { created_at: "asc" },
    }),
    prisma.exerciseRecord.findMany({
      where: { user_id, date: today },
      orderBy: { created_at: "asc" },
    }),
    prisma.aiParseLog.findMany({
      where: { user_id },
      orderBy: { created_at: "desc" },
      take: TURN_WINDOW,
    }),
  ]);

  // L1 今日记录快照（食物 r*、运动 e*）
  const recent_records: RecordRef[] = [
    ...foods.map((f, i) => ({
      ref: `r${i + 1}`,
      record_id: f.id,
      kind: "food" as const,
      name: f.food?.name ?? f.raw_input ?? "未知",
      meal_type: f.meal_type,
      portion: f.portion_label,
      weight_g: Math.round(f.weight_g),
      calories: Math.round(f.calories),
    })),
    ...exercises.map((e, i) => ({
      ref: `e${i + 1}`,
      record_id: e.id,
      kind: "exercise" as const,
      name: e.type,
      duration_min: e.duration_min ?? undefined,
      calories: Math.round(e.calories_burned),
    })),
  ];

  // L0 对话窗口：ai_parse_log 倒序取后转正序（旧→新，便于按时序理解指代）
  const recent_turns: TurnSummary[] = logs
    .slice()
    .reverse()
    .map((log) => {
      const turn: TurnSummary = { said: log.input_text, intent: log.intent };
      const pj = log.parsed_json as any;
      if (log.intent === "record" && Array.isArray(pj?.items)) {
        turn.foods = pj.items.map((it: any) => ({
          name: it.canonical || it.raw || "",
          portion: it.chosen_label || "",
        }));
      }
      return turn;
    });

  return {
    profile: {
      gender: user.gender,
      age: user.age,
      height_cm: user.height_cm != null ? Number(user.height_cm) : null,
      weight_kg: user.weight_kg != null ? Number(user.weight_kg) : null,
      target_weight_kg: user.target_weight_kg != null ? Number(user.target_weight_kg) : null,
      goal_type: user.goal_type,
      daily_deficit: user.daily_deficit,
      activity_level: user.activity_level,
    },
    card,
    recent_records,
    recent_turns,
  };
}

// 渲染为紧凑文本块，作为 system context 拼进 prompt（去 payload、去闲聊长文本）
export function renderMemoryBlock(pack: MemoryPack): string {
  const { profile: p, card, recent_records, recent_turns } = pack;
  const lines: string[] = [];

  // L2 画像 + 今日进度
  const prof: string[] = [];
  if (p.gender) prof.push(p.gender === "male" ? "男" : "女");
  if (p.age != null) prof.push(`${p.age}岁`);
  if (p.height_cm != null) prof.push(`身高${p.height_cm}`);
  if (p.weight_kg != null) prof.push(`体重${p.weight_kg}`);
  if (p.target_weight_kg != null) prof.push(`目标体重${p.target_weight_kg}`);
  prof.push(p.goal_type === "cut" ? "目标减脂" : "目标维持");
  prof.push(`每日缺口${p.daily_deficit}`);
  lines.push(`【用户档案】${prof.join(" ")}`);
  lines.push(
    `【今日进度】摄入${card.today.in} 目标${card.targets.calories} 还可吃${card.today.remaining} 蛋白${card.today.p}/${card.targets.protein}`
  );

  // L1 今日已记录
  if (recent_records.length > 0) {
    lines.push("【今日已记录】");
    for (const r of recent_records) {
      if (r.kind === "food") {
        lines.push(
          `- ${r.ref} ${MEAL_ZH[r.meal_type ?? ""] ?? ""}·${r.name} ${PORTION_ZH[r.portion ?? ""] ?? ""} ${r.weight_g}g ${r.calories}kcal`
        );
      } else {
        lines.push(`- ${r.ref} 运动·${r.name} ${r.duration_min ?? "?"}min 消耗${r.calories}kcal`);
      }
    }
  }

  // L0 最近对话（旧→新）
  if (recent_turns.length > 0) {
    lines.push("【最近对话】(旧→新)");
    for (const t of recent_turns) {
      const act =
        t.intent === "record"
          ? `记录(${(t.foods ?? []).map((f) => `${f.name}/${f.portion}`).join("、")})`
          : t.intent === "query"
          ? "查询"
          : t.intent === "chat"
          ? "闲聊/咨询"
          : "?";
      lines.push(`- 用户:"${t.said}" → ${act}`);
    }
  }

  return lines.join("\n");
}
