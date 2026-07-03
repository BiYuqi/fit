import { prisma } from "../lib/prisma";
import { buildContextCard, type ContextCard } from "./summary";
import { biasEnabled } from "./learning";
import { PENDING_STALE_MS } from "./pending-resolve";

// 份量倾向的显著性门槛：|μ|≥0.15（≈±16%）且 n_eff≥2 才算"习惯"，避免噪声进 prompt
const HABIT_MU_MIN = 0.15;
const HABIT_N_MIN = 2;
const HABIT_LIMIT = 5;

async function buildPortionHabits(user_id: string): Promise<PortionHabit[]> {
  if (!biasEnabled()) return [];
  try {
    const rows = await prisma.userBias.findMany({
      where: { user_id, scope: "food", n_eff: { gte: HABIT_N_MIN } },
      orderBy: { n_eff: "desc" },
      take: 20,
    });
    const significant = rows.filter((r) => Math.abs(r.mu) >= HABIT_MU_MIN).slice(0, HABIT_LIMIT);
    if (significant.length === 0) return [];
    const foods = await prisma.foodStandard.findMany({
      where: { id: { in: significant.map((r) => r.scope_key) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(foods.map((f) => [f.id, f.name]));
    return significant
      .filter((r) => nameById.has(r.scope_key))
      .map((r) => ({
        name: nameById.get(r.scope_key)!,
        tendency: r.mu > 0 ? ("large" as const) : ("small" as const),
      }));
  } catch {
    return [];
  }
}

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
  said: string;                                  // 用户原话（来自 ai_parse_log.input_text；卡片动作为 "[点选卡片]"）
  intent: string | null;                         // record / query / chat / modify / discuss / resolve
  at?: Date;                                     // 发生时刻（ai_parse_log.created_at），供 L0 相对时间标注
  foods?: Array<{ name: string; portion: string }>; // record / resolve 意图时的动作锚点
  reply?: string;                                // AI 回复摘要（ai_parse_log.reply_summary，T37 双向记忆）
}

export interface DaySummary {
  date: string;   // YYYY-MM-DD
  in: number;
  deficit: number;
  p: number;
  f: number;
  c: number;
}

export interface PortionHabit {
  name: string; // 食物名
  tendency: "large" | "small"; // 相对 AI 估算的方向（不给数字，数字修正在后端 applyBias）
}

// 待确认卡摘要（T38 pending 感知）：喂给 parser 让它知道"当前有张卡等着被回答"，
// 用户打字回答（"中份"/"都不是，是酱香饼"/"180克"）才能被识别为 resolve_pending 而不是新记录/闲聊。
export interface PendingSummary {
  id: string;
  type: string; // portion_choice | food_choice | delete_confirm
  food_name?: string;                                        // portion_choice / delete_confirm
  portions?: Array<{ label: string; grams: number; unit?: string }>; // portion_choice
  query?: string;                                             // food_choice：用户原始泛称（"煎饼"）
  candidate_names?: string[];                                 // food_choice：候选具体食物名
}

export interface MemoryPack {
  profile: MemoryProfile;
  card: ContextCard;
  recent_records: RecordRef[];
  recent_turns: TurnSummary[];
  recent_days: DaySummary[];   // 近3天每日汇总（不含今天）
  portion_habits: PortionHabit[]; // 学到的份量倾向（LEARNING_SPEC §6，T31），只影响 chosen_label
  pending: PendingSummary | null; // 最新未过期的待确认卡（T38），null=当前无待确认
}

async function buildPendingSummary(user_id: string): Promise<PendingSummary | null> {
  const pr = await prisma.pendingRecord.findFirst({
    where: {
      user_id,
      status: "pending",
      created_at: { gte: new Date(Date.now() - PENDING_STALE_MS) },
    },
    orderBy: { created_at: "desc" },
  });
  if (!pr) return null;
  const c = pr.candidates as any;
  if (pr.type === "portion_choice") {
    return { id: pr.id, type: pr.type, food_name: c.food_name, portions: c.portions };
  }
  if (pr.type === "food_choice") {
    return { id: pr.id, type: pr.type, query: c.query, candidate_names: c.candidate_names };
  }
  if (pr.type === "delete_confirm") {
    return { id: pr.id, type: pr.type, food_name: c.name };
  }
  return { id: pr.id, type: pr.type };
}

export async function buildMemoryPack(user_id: string): Promise<MemoryPack> {
  const todayDate = toDateOnly(todayStr());

  // 近3天（不含今天）的起始日
  const threeDaysAgo = new Date(todayDate);
  threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
  const yesterday = new Date(todayDate);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const [user, card, foods, exercises, logs, summaryRows, liveAgg, portion_habits, pending] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: user_id } }),
    buildContextCard(user_id),
    prisma.foodRecord.findMany({
      where: { user_id, date: todayDate },
      include: { food: true },
      orderBy: { created_at: "asc" },
    }),
    prisma.exerciseRecord.findMany({
      where: { user_id, date: todayDate },
      orderBy: { created_at: "asc" },
    }),
    prisma.aiParseLog.findMany({
      where: { user_id },
      orderBy: { created_at: "desc" },
      take: TURN_WINDOW,
    }),
    // 近3天已有 summary 的天
    prisma.dailySummary.findMany({
      where: { user_id, date: { gte: threeDaysAgo, lte: yesterday } },
      orderBy: { date: "desc" },
    }),
    // 近3天有记录但可能没有 summary 的天（实时聚合兜底）
    prisma.foodRecord.groupBy({
      by: ["date"],
      where: { user_id, date: { gte: threeDaysAgo, lte: yesterday } },
      _sum: { calories: true, protein: true, fat: true, carbs: true },
    }),
    buildPortionHabits(user_id),
    buildPendingSummary(user_id),
  ]);

  // 合并：summary 优先，没有则用 foodRecord 实时聚合
  const summaryMap = new Map(
    summaryRows.map((r) => [r.date.toISOString().slice(0, 10), r])
  );
  const liveMap = new Map(
    liveAgg.map((r) => [r.date.toISOString().slice(0, 10), r])
  );

  const allDates = new Set([...summaryMap.keys(), ...liveMap.keys()]);
  const recent_days: DaySummary[] = Array.from(allDates)
    .sort()
    .reverse()
    .map((date) => {
      const s = summaryMap.get(date);
      if (s) {
        return {
          date,
          in: Math.round(s.calories_in),
          deficit: Math.round(s.deficit),
          p: Math.round(s.protein),
          f: Math.round(s.fat),
          c: Math.round(s.carbs),
        };
      }
      const l = liveMap.get(date)!;
      return {
        date,
        in: Math.round(l._sum.calories ?? 0),
        deficit: 0,
        p: Math.round(l._sum.protein ?? 0),
        f: Math.round(l._sum.fat ?? 0),
        c: Math.round(l._sum.carbs ?? 0),
      };
    });

  const today = todayDate;

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
      const turn: TurnSummary = { said: log.input_text, intent: log.intent, at: log.created_at };
      if (log.reply_summary) turn.reply = log.reply_summary;
      const pj = log.parsed_json as any;
      if (log.intent === "record" && Array.isArray(pj?.items)) {
        turn.foods = pj.items.map((it: any) => ({
          name: it.canonical || it.raw || "",
          portion: it.chosen_label || "",
        }));
      } else if (log.intent === "resolve" && pj?.food_name) {
        // 卡片点选轮（T37）：parsed_json 是 ResolveAction，food_name 作指代锚点
        turn.foods = [{ name: pj.food_name, portion: pj.portion_label ?? "" }];
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
    recent_days,
    portion_habits,
    pending,
  };
}
