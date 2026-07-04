// ────────────────────────────────────────────────────────────
// 查询计划（T44）：AI 填单、后端执行的通用历史查询
//
// 复刻食物匹配的分工哲学（铁律4）：AI 只输出"要查什么"的结构化计划
// （受限 JSON 表单），后端 zod 校验后确定性执行 SQL。AI 全程碰不到数据库。
//
// 安全边界（写死，永不放宽）：
//   - 计划里没有 user_id 字段，执行器的 user_id 永远来自 JWT（词汇上无法越权）
//   - 只查 food_record / exercise_record / daily_summary 三张事实表，
//     chat_message 物理不可达（铁律3）
//   - 只读：本文件只允许 findMany / aggregate / groupBy，无任何写路径
//     （query-plan.test.ts 有源码扫描测试兜底）
//   - 区间上限 RANGE_MAX_DAYS 天，明细上限 ITEMS_MAX 条，防撑爆上下文（T37 预算原则）
// ────────────────────────────────────────────────────────────

import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { callDeepSeekCtx } from "../../ai/ctx";
import { recordTokenUsage } from "../token";
import type { MemoryPack } from "../memory";
import { todayStr, toDateOnly } from "../../lib/dates";

export const RANGE_MAX_DAYS = 92;
export const ITEMS_MAX = 40;
export const DAILY_MAX_DAYS = 31; // daily 超过则降为 total，附说明
const BY_FOOD_TOP = 10;
const REPORT_TOP = 5;

// ---------- QueryPlan schema ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 相对日期一律用符号，由 resolveRange 确定性解析——AI 不做日期算术（铁律1精神）
const RangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["today", "yesterday", "this_week", "last_week", "this_month", "last_month"]) }).strict(),
  z.object({ type: z.literal("last_n_days"), n: z.number().int().min(1).max(RANGE_MAX_DAYS) }).strict(),
  z.object({ type: z.literal("day"), date: z.string().regex(DATE_RE) }).strict(),
  z.object({ type: z.literal("range"), from: z.string().regex(DATE_RE), to: z.string().regex(DATE_RE) }).strict(),
]);

export const QueryPlanSchema = z
  .object({
    range: RangeSchema,
    target: z.enum(["food", "exercise", "both"]).default("both"),
    food_filter: z.string().min(1).optional(),
    meal_filter: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
    detail: z.enum(["total", "daily", "items", "report", "by_food"]),
  })
  .strict(); // 多余字段（如 AI 幻觉出的 user_id）直接拒绝
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

// ---------- 日期区间解析（纯函数，单测覆盖）----------

export interface ResolvedRange {
  from: string; // YYYY-MM-DD，含
  to: string;   // YYYY-MM-DD，含
  days: number;
  note?: string; // 截断说明（超上限时告知 AI）
}

function shiftDate(dateStr: string, deltaDays: number): string {
  const d = toDateOnly(dateStr);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.round((toDateOnly(to).getTime() - toDateOnly(from).getTime()) / 86400000) + 1;
}

// 返回 null 表示区间完全在未来（如"明天吃了啥"），无数据可查
export function resolveRange(range: QueryPlan["range"], today: string): ResolvedRange | null {
  let from: string;
  let to: string;
  switch (range.type) {
    case "today":
      from = to = today;
      break;
    case "yesterday":
      from = to = shiftDate(today, -1);
      break;
    case "this_week": {
      // 周一为一周之始（中文语境约定）
      const dow = toDateOnly(today).getUTCDay(); // 0=周日
      from = shiftDate(today, -((dow + 6) % 7));
      to = today;
      break;
    }
    case "last_week": {
      const dow = toDateOnly(today).getUTCDay();
      const thisMonday = shiftDate(today, -((dow + 6) % 7));
      from = shiftDate(thisMonday, -7);
      to = shiftDate(thisMonday, -1);
      break;
    }
    case "this_month":
      from = today.slice(0, 8) + "01";
      to = today;
      break;
    case "last_month": {
      const firstOfThis = today.slice(0, 8) + "01";
      to = shiftDate(firstOfThis, -1);
      from = to.slice(0, 8) + "01";
      break;
    }
    case "last_n_days":
      from = shiftDate(today, -(range.n - 1));
      to = today;
      break;
    case "day":
      from = to = range.date;
      break;
    case "range":
      from = range.from <= range.to ? range.from : range.to;
      to = range.from <= range.to ? range.to : range.from;
      break;
  }

  if (from > today) return null; // 整段在未来
  let note: string | undefined;
  if (to > today) {
    to = today; // 尾部伸进未来的截到今天
  }
  if (spanDays(from, to) > RANGE_MAX_DAYS) {
    from = shiftDate(to, -(RANGE_MAX_DAYS - 1));
    note = `（区间过长，已截取最近${RANGE_MAX_DAYS}天）`;
  }
  return { from, to, days: spanDays(from, to), note };
}

// ---------- 取数（三表白名单，只读）----------

export interface FoodRow {
  date: string;
  name: string;
  grams: number;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  meal_type: string | null;
}
export interface ExerciseRow {
  date: string;
  type: string;
  duration_min: number | null;
  calories: number;
}
export interface SummaryRow {
  date: string;
  calories_in: number;
  protein: number;
  fat: number;
  carbs: number;
  deficit: number;
  target_calories: number;
}
export interface QueryRows {
  foods: FoodRow[];
  exercises: ExerciseRow[];
  summaries: SummaryRow[];
}

async function fetchRows(user_id: string, plan: QueryPlan, r: ResolvedRange): Promise<QueryRows> {
  const dateWhere = { gte: toDateOnly(r.from), lte: toDateOnly(r.to) };
  const [foods, exercises, summaries] = await Promise.all([
    plan.target === "exercise"
      ? []
      : prisma.foodRecord.findMany({
          where: {
            user_id,
            date: dateWhere,
            ...(plan.meal_filter ? { meal_type: plan.meal_filter } : {}),
            ...(plan.food_filter
              ? {
                  OR: [
                    { food: { name: { contains: plan.food_filter } } },
                    { raw_input: { contains: plan.food_filter } },
                  ],
                }
              : {}),
          },
          include: { food: true },
          orderBy: [{ date: "asc" }, { created_at: "asc" }],
        }),
    plan.target === "food"
      ? []
      : prisma.exerciseRecord.findMany({
          where: { user_id, date: dateWhere },
          orderBy: [{ date: "asc" }, { created_at: "asc" }],
        }),
    // food_filter 下的统计只看命中记录本身，summary 不参与
    plan.food_filter
      ? []
      : prisma.dailySummary.findMany({ where: { user_id, date: dateWhere }, orderBy: { date: "asc" } }),
  ]);
  return {
    foods: foods.map((f) => ({
      date: f.date.toISOString().slice(0, 10),
      name: f.food?.name ?? f.raw_input ?? "未知食物",
      grams: Math.round(f.weight_g),
      calories: Math.round(f.calories),
      protein: Math.round(f.protein),
      fat: Math.round(f.fat),
      carbs: Math.round(f.carbs),
      meal_type: f.meal_type,
    })),
    exercises: exercises.map((e) => ({
      date: e.date.toISOString().slice(0, 10),
      type: e.type,
      duration_min: e.duration_min,
      calories: Math.round(e.calories_burned),
    })),
    summaries: summaries.map((s) => ({
      date: s.date.toISOString().slice(0, 10),
      calories_in: Math.round(s.calories_in),
      protein: Math.round(s.protein),
      fat: Math.round(s.fat),
      carbs: Math.round(s.carbs),
      deficit: Math.round(s.deficit),
      target_calories: Math.round(s.target_calories),
    })),
  };
}

// ---------- 渲染（纯函数，单测覆盖）----------

const MEAL_ZH: Record<string, string> = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐" };

interface DayAgg {
  date: string;
  in: number;
  p: number;
  f: number;
  c: number;
  deficit: number | null;        // 仅 summary 覆盖的天有
  target: number | null;
}

// 按天聚合：summary 优先（有 deficit/target），无则由 food 明细实时聚合兜底（与 memory.ts recent_days 同口径）
function buildDayAggs(rows: QueryRows): DayAgg[] {
  const byDate = new Map<string, DayAgg>();
  for (const s of rows.summaries) {
    byDate.set(s.date, {
      date: s.date, in: s.calories_in, p: s.protein, f: s.fat, c: s.carbs,
      deficit: s.deficit, target: s.target_calories,
    });
  }
  const summaryDates = new Set(rows.summaries.map((s) => s.date));
  for (const f of rows.foods) {
    if (summaryDates.has(f.date)) continue; // summary 已覆盖该天，不重复累加
    const d = byDate.get(f.date) ?? { date: f.date, in: 0, p: 0, f: 0, c: 0, deficit: null, target: null };
    d.in += f.calories;
    d.p += f.protein;
    d.f += f.fat;
    d.c += f.carbs;
    byDate.set(f.date, d);
  }
  return [...byDate.values()].filter((d) => d.in > 0).sort((a, b) => a.date.localeCompare(b.date));
}

// 衍生统计由后端算好给 AI（铁律1：绝不扔原始数据让 AI 自己算均值）
function statsLine(days: DayAgg[]): string | null {
  if (days.length === 0) return null;
  const n = days.length;
  const avgIn = Math.round(days.reduce((s, d) => s + d.in, 0) / n);
  const avgP = Math.round(days.reduce((s, d) => s + d.p, 0) / n);
  const max = days.reduce((m, d) => (d.in > m.in ? d : m));
  const min = days.reduce((m, d) => (d.in < m.in ? d : m));
  const parts = [
    `记录${n}天`,
    `日均摄入${avgIn}kcal 日均蛋白${avgP}g`,
    `最高${max.date}(${max.in}kcal) 最低${min.date}(${min.in}kcal)`,
  ];
  const withTarget = days.filter((d) => d.target != null && d.target > 0);
  if (withTarget.length > 0) {
    const over = withTarget.filter((d) => d.in > d.target!).length;
    parts.push(`超目标${over}天/${withTarget.length}天`);
  }
  return `统计：${parts.join("，")}`;
}

function foodItemLine(f: FoodRow, withDate: boolean): string {
  const date = withDate ? `${f.date.slice(5)} ` : "";
  const meal = f.meal_type ? `${MEAL_ZH[f.meal_type] ?? ""}·` : "";
  return `${date}${meal}${f.name} ${f.grams}g(约${f.calories}kcal)`;
}

function exerciseItemLine(e: ExerciseRow, withDate: boolean): string {
  const date = withDate ? `${e.date.slice(5)} ` : "";
  return `${date}运动·${e.type}${e.duration_min ? `${e.duration_min}分钟` : ""}(消耗${e.calories}kcal)`;
}

function byFoodLines(foods: FoodRow[], top: number): string[] {
  const byName = new Map<string, { count: number; calories: number }>();
  for (const f of foods) {
    const g = byName.get(f.name) ?? { count: 0, calories: 0 };
    g.count += 1;
    g.calories += f.calories;
    byName.set(f.name, g);
  }
  return [...byName.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].calories - a[1].calories)
    .slice(0, top)
    .map(([name, g]) => `${name} ×${g.count}次 共${g.calories}kcal`);
}

export function renderQueryResult(plan: QueryPlan, r: ResolvedRange, rows: QueryRows): string {
  const rangeLabel = r.from === r.to ? r.from : `${r.from}~${r.to}(共${r.days}天)`;
  const header = `【实时查询】${rangeLabel}${r.note ?? ""}`;
  const filterLabel = [
    plan.food_filter ? `食物「${plan.food_filter}」` : "",
    plan.meal_filter ? MEAL_ZH[plan.meal_filter] : "",
  ].filter(Boolean).join(" ");

  if (rows.foods.length === 0 && rows.exercises.length === 0) {
    return `${header} ${filterLabel ? `${filterLabel}：` : ""}此范围没有任何记录`;
  }

  const days = buildDayAggs(rows);
  const multiDay = r.days > 1;
  const lines: string[] = [header + (filterLabel ? ` ${filterLabel}` : "")];

  const pushItems = () => {
    const all = [
      ...rows.foods.map((f) => foodItemLine(f, multiDay)),
      ...rows.exercises.map((e) => exerciseItemLine(e, multiDay)),
    ];
    const shown = all.slice(0, ITEMS_MAX);
    if (plan.food_filter) lines.push(`「${plan.food_filter}」共${rows.foods.length}次`);
    lines.push(`明细：${shown.join("、")}`);
    if (all.length > shown.length) lines.push(`（另有${all.length - shown.length}条已折叠）`);
  };
  const pushDaily = () => {
    for (const d of days) {
      const target = d.target != null && d.target > 0 ? ` 目标${d.target}kcal` : "";
      lines.push(`${d.date} 摄入${d.in}kcal 蛋白${d.p}g 脂肪${d.f}g 碳水${d.c}g${target}`);
    }
  };
  const pushTotal = () => {
    const totalIn = rows.foods.reduce((s, f) => s + f.calories, 0);
    const totalP = rows.foods.reduce((s, f) => s + f.protein, 0);
    const totalF = rows.foods.reduce((s, f) => s + f.fat, 0);
    const totalC = rows.foods.reduce((s, f) => s + f.carbs, 0);
    if (rows.foods.length > 0) {
      lines.push(`总摄入${totalIn}kcal 蛋白${totalP}g 脂肪${totalF}g 碳水${totalC}g（共${rows.foods.length}条食物记录）`);
    }
    if (rows.exercises.length > 0) {
      const totalOut = rows.exercises.reduce((s, e) => s + e.calories, 0);
      lines.push(`运动共${rows.exercises.length}次 消耗${totalOut}kcal`);
    }
  };
  const pushStats = () => {
    const s = statsLine(days);
    if (s) lines.push(s);
  };

  switch (plan.detail) {
    case "items":
      pushItems();
      break;
    case "daily":
      if (r.days > DAILY_MAX_DAYS) {
        lines.push(`（区间超${DAILY_MAX_DAYS}天，不逐日列出，只给总量与统计）`);
        pushTotal();
      } else {
        pushDaily();
      }
      pushStats();
      break;
    case "total":
      pushTotal();
      pushStats();
      break;
    case "by_food":
      if (plan.food_filter) lines.push(`「${plan.food_filter}」共${rows.foods.length}次`);
      lines.push(...byFoodLines(rows.foods, BY_FOOD_TOP));
      break;
    case "report": {
      pushStats();
      if (r.days <= DAILY_MAX_DAYS) pushDaily();
      else pushTotal();
      const top = byFoodLines(rows.foods, REPORT_TOP);
      if (top.length > 0) lines.push(`常吃Top${top.length}：${top.join("；")}`);
      if (rows.exercises.length > 0) {
        const totalOut = rows.exercises.reduce((s, e) => s + e.calories, 0);
        lines.push(`运动共${rows.exercises.length}次 消耗${totalOut}kcal`);
      }
      break;
    }
  }
  return lines.join("\n");
}

// ---------- 执行器 ----------

// 返回给 answerQuery 的 extraCtx 文本；区间在未来时也返回明确说明，让 AI 如实回答
export async function executeQueryPlan(user_id: string, plan: QueryPlan): Promise<string> {
  const r = resolveRange(plan.range, todayStr());
  if (!r) return `【实时查询】询问的日期在未来，没有记录`;
  const rows = await fetchRows(user_id, plan, r);
  return renderQueryResult(plan, r, rows);
}

// ---------- planner（flash → pro 重试，同 chat.ts 解析升级模式）----------

export const QUERY_PLAN_TOOL_NAME = "plan_query";

const queryPlanToolSchema = {
  type: "function" as const,
  function: {
    name: QUERY_PLAN_TOOL_NAME,
    strict: true,
    description: "把用户关于自己饮食/运动历史的统计问题转成结构化查询计划，由后端执行数据库查询。",
    parameters: {
      type: "object",
      required: ["range", "detail"],
      additionalProperties: false,
      properties: {
        range: {
          type: "object",
          required: ["type"],
          additionalProperties: false,
          description: "查询的日期范围。相对日期一律用符号（today/yesterday/this_week/last_week/this_month/last_month/last_n_days），不要自己换算成具体日期；只有用户点名明确日期（如'6月5日'）才用 day，年份按【当前日期】补全",
          properties: {
            type: {
              type: "string",
              enum: ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_n_days", "day", "range"],
            },
            n: { type: "number", description: "仅 type=last_n_days：最近 N 天（'最近一周'→7，'最近10天'→10）" },
            date: { type: "string", description: "仅 type=day：YYYY-MM-DD" },
            from: { type: "string", description: "仅 type=range：YYYY-MM-DD" },
            to: { type: "string", description: "仅 type=range：YYYY-MM-DD" },
          },
        },
        target: {
          type: "string",
          enum: ["food", "exercise", "both"],
          description: "只问吃→food；只问运动→exercise；都问或不明确→both",
        },
        food_filter: {
          type: "string",
          description: "只统计某种食物时填（'吃了几次红烧肉'→'红烧肉'），食物名本身，不带次数/日期词",
        },
        meal_filter: {
          type: "string",
          enum: ["breakfast", "lunch", "dinner", "snack"],
          description: "只问某一餐时填（'昨天晚饭吃了啥'→dinner）",
        },
        detail: {
          type: "string",
          enum: ["total", "daily", "items", "report", "by_food"],
          description: "total=只要总量/均值（'上周平均摄入多少'）；daily=按天列（'这几天每天吃了多少'）；items=逐条明细（'具体吃了什么/几次某食物'）；report=总结/表现/吃得怎么样（'总结下我上个月饮食'）；by_food=按食物排行（'我最常吃什么'）",
        },
      },
    },
  },
};

const PLANNER_PROMPT = `你是查询计划生成器：把用户关于自己饮食/运动数据的问题转成一份结构化查询计划（调用 plan_query 工具），由后端执行真正的数据库查询。你只决定"要查什么"，不回答问题本身。

规则：
- 相对日期用符号：昨天→yesterday，本周→this_week，上周→last_week，这个月→this_month，上个月→last_month，最近N天→last_n_days。不要自己把相对日期换算成具体日期。
- 用户点名明确日期（"6月5日"、"7月1号"）才用 day，年份按【当前日期】所在年补全；说了一段明确日期（"6月1日到6月10日"）用 range。
- 跟进式细问（"具体吃了什么"、"都有哪些"）本身不带日期时，沿用【最近对话】里上一轮查询所指的日期。
- "吃了几次X/吃过X吗" → detail=items + food_filter=X（次数由后端数好）。
- "总结/回顾/表现/吃得怎么样" → detail=report。
- 问某一餐（早饭/午饭/晚饭/加餐/宵夜）→ meal_filter（宵夜→snack）。`;

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

async function planOnce(text: string, pack: MemoryPack, userId: string, model: string): Promise<{ plan: QueryPlan; usage: Usage }> {
  const { res } = await callDeepSeekCtx(
    pack,
    [
      { role: "system", content: PLANNER_PROMPT },
      { role: "user", content: text },
    ],
    {
      model,
      tools: [queryPlanToolSchema],
      tool_choice: { type: "function", function: { name: QUERY_PLAN_TOOL_NAME } },
    },
  );
  // token 记账在校验之前：解析失败 token 也已消耗
  const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  await recordTokenUsage({
    userId,
    model,
    purpose: "query_plan",
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  });

  const toolCall = res.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function" || toolCall.function.name !== QUERY_PLAN_TOOL_NAME) {
    throw new Error("planner did not return expected tool call");
  }
  const plan = QueryPlanSchema.parse(JSON.parse(toolCall.function.arguments));
  return { plan, usage };
}

export async function planQuery(
  text: string,
  pack: MemoryPack,
  userId: string,
): Promise<{ plan: QueryPlan; usage: Usage; model: string; upgraded: boolean }> {
  try {
    const { plan, usage } = await planOnce(text, pack, userId, "deepseek-v4-flash");
    return { plan, usage, model: "deepseek-v4-flash", upgraded: false };
  } catch {
    // flash 失败（tool call 缺失 / JSON / zod 校验），升 pro 重试一次
    const { plan, usage } = await planOnce(text, pack, userId, "deepseek-v4-pro");
    return { plan, usage, model: "deepseek-v4-pro", upgraded: true };
  }
}
