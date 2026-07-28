// 对话回归评测集回放器（T41）
// 用法：npm run eval [-- --case <name>] [-- --clean]
// 前提：后端已启动（./start.sh），.env 有 DEEPSEEK_API_KEY。
// 设计决策见 docs/tasks/T41-conversation-eval.md：一次性账号、结构化断言、known_fail 允许带红灯。
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { prisma } from "../src/lib/prisma";
import { recompute } from "../src/services/summary";

const API = process.env.EVAL_API_BASE ?? "http://localhost:9300";
const CASES_DIR = join(__dirname, "cases");

// ---------- 用例 schema ----------
interface EvalCase {
  name: string;
  profile?: Record<string, unknown>; // 覆盖默认档案（PUT /user/profile 的字段）
  setup?: {
    food_alias?: Array<{ canonical: string; food: string; streak?: number; hits?: number }>;
    // T44：种历史食物记录。days_ago 相对今天（1=昨天），用相对天数避免用例被日历边界（月初/周一）搞抖
    food_record?: Array<{ days_ago: number; food: string; grams: number; meal_type?: string }>;
    // 体重趋势查询：种历史体重实测点（days_ago 相对今天，1=昨天）
    weight_log?: Array<{ days_ago: number; kg: number }>;
    // T74：种已有语义记忆（作废通道必须有东西可作废）
    memory?: Array<{
      type: string; entity: string; content: string;
      state?: string; llm_confidence?: number; importance_class?: string;
    }>;
  };
  turns: Turn[];
}
interface Turn {
  say?: string;
  resolve?: { choice: string | { grams: number } }; // 对最新 open pending 执行 /pending/:id/resolve
  expect?: Expect;
  known_fail?: string; // 已知缺陷对应的任务号（如 "T40"）：红灯归入已知缺陷，不算新回归
}
interface Expect {
  intent?: string | string[];
  reply_contain?: string[];     // 全部子串必须出现
  reply_contain_any?: string[]; // 至少一个子串出现
  reply_forbid?: string[];      // 正则，命中即失败（只读路径禁谎称等红线）
  db?: {
    // 单条断言，或多条（T53 批量改：一句改多样，逐条断言每条落对）
    food_record?:
      | ({ where?: { food_name?: string; meal_type?: string } } & Record<string, unknown>)
      | Array<{ where?: { food_name?: string; meal_type?: string } } & Record<string, unknown>>;
    food_record_count?: number;
    exercise_record?: { where?: { type?: string } } & Record<string, unknown>; // T50：断言运动记录字段（calories_burned/duration_min 等）
    exercise_record_count?: number; // T73：断言"该入库的入了、不该入库的没入"（习惯陈述不建记录）
    pending_record?: { type?: string } | null; // null = 断言无 open pending
    last_card?: string; // 最新 assistant 消息的 kind
    weight_chart?: { points?: number; kgs?: number[] }; // 最近一张 weight_chart 卡的折线点断言
    weight_log?: { weight_kg?: number }; // 最近一个体重历史点（record_weight 写入）
    user?: { weight_kg?: number }; // 档案字段断言：record_weight 绝不能改初始体重
    // T74：语义记忆断言。state 省略时只断言"这条存在"；absent=true 断言这条根本没建
    memory?: Array<{
      entity: string; type?: string; state?: string;
      valid_to?: boolean; absent?: boolean;
    }>;
  };
}

// ---------- 默认档案（用例可覆盖）----------
const DEFAULT_PROFILE = {
  gender: "male", age: 30, height_cm: 175, weight_kg: 70,
  target_weight_kg: 65, activity_level: "moderate", goal_type: "cut", daily_deficit: 500,
};

// ---------- API helpers ----------
async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json as any;
}

async function registerEvalUser(): Promise<{ token: string; userId: string; account: string }> {
  const account = `eval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const { token } = await api("/api/auth/register", { method: "POST", body: { account, password: "eval-pass-123" } });
  const user = await prisma.user.findUniqueOrThrow({ where: { account }, select: { id: true } });
  return { token, userId: user.id, account };
}

// ---------- setup：显式造前提状态（不依赖账号残留）----------
async function runSetup(userId: string, setup: EvalCase["setup"]) {
  for (const a of setup?.food_alias ?? []) {
    const food = await prisma.foodStandard.findFirst({ where: { name: a.food } });
    if (!food) throw new Error(`setup.food_alias: 食物库中找不到「${a.food}」（用例前提无法建立）`);
    await prisma.userFoodAlias.create({
      data: { user_id: userId, canonical: a.canonical, food_id: food.id, streak: a.streak ?? 2, hits: a.hits ?? a.streak ?? 2 },
    });
  }
  // 种历史食物记录：热量按 food_standard 每100g × 克数（与后端 calc 同口径），种完跑 recompute 生成当日 summary
  const touchedDates = new Set<string>();
  for (const r of setup?.food_record ?? []) {
    // 精确名优先，contains 兜底（库里主食多带括号后缀，如"米饭（蒸，代表值）"）
    const food =
      (await prisma.foodStandard.findFirst({ where: { name: r.food } })) ??
      (await prisma.foodStandard.findFirst({ where: { name: { contains: r.food } }, orderBy: { name: "asc" } }));
    if (!food) throw new Error(`setup.food_record: 食物库中找不到「${r.food}」（用例前提无法建立）`);
    const local = new Date(Date.now() + 8 * 3600 * 1000);
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - r.days_ago));
    const dateStr = day.toISOString().slice(0, 10);
    const per = (v: number | null) => Math.round(((v ?? 0) * r.grams) / 100);
    await prisma.foodRecord.create({
      data: {
        user_id: userId,
        food_id: food.id,
        meal_type: (r.meal_type ?? "lunch") as never,
        portion_label: "custom",
        weight_g: r.grams,
        calories: per(food.calories_100g),
        protein: per(food.protein_100g),
        fat: per(food.fat_100g),
        carbs: per(food.carbs_100g),
        raw_input: `[eval-setup] ${r.food} ${r.grams}g`,
        date: day,
      },
    });
    touchedDates.add(dateStr);
  }
  for (const d of touchedDates) await recompute(userId, d);

  // 种已有语义记忆（T74 作废通道：得先有 ACTIVE 记忆才谈得上作废）
  for (const m of setup?.memory ?? []) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "UserMemory"
       (id,user_id,type,entity,content,llm_confidence,importance_class,repetition_count,state,
        source_type,valid_from,last_accessed_at,updated_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,1,$7,'explicit_user',now(),now(),now())`,
      userId, m.type, m.entity, m.content,
      m.llm_confidence ?? 0.9, m.importance_class ?? "normal", m.state ?? "ACTIVE",
    );
  }

  // 种历史体重实测点（同 record_weight 的落库口径：每日一行，覆盖式）
  for (const w of setup?.weight_log ?? []) {
    const local = new Date(Date.now() + 8 * 3600 * 1000);
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - w.days_ago));
    await prisma.weightLog.upsert({
      where: { user_id_date: { user_id: userId, date: day } },
      update: { weight_kg: w.kg },
      create: { user_id: userId, date: day, weight_kg: w.kg },
    });
  }
}

// ---------- 断言 ----------
interface Failure { what: string; expected: unknown; actual: unknown }

// 相对天数 → "YYYY-MM-DD"，与 runSetup 的 setup.food_record.days_ago 同一套本地日边界算法（T62）
function daysAgoStr(n: number): string {
  const local = new Date(Date.now() + 8 * 3600 * 1000);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - n));
  return day.toISOString().slice(0, 10);
}

function checkFields(failures: Failure[], label: string, expected: Record<string, unknown>, actual: Record<string, unknown> | null) {
  if (!actual) {
    failures.push({ what: label, expected, actual: null });
    return;
  }
  for (const [k, v] of Object.entries(expected)) {
    if (k === "where") continue;
    // date_days_ago：断言 actual.date 相对今天的天数偏移（用例不硬编码绝对日期，T62）
    if (k === "date_days_ago") {
      const rawDate = actual.date;
      const aDate = rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : rawDate;
      const expectedDate = daysAgoStr(v as number);
      if (aDate !== expectedDate) failures.push({ what: `${label}.date`, expected: expectedDate, actual: aDate });
      continue;
    }
    // @db.Date 字段（如 food_record.date）是 Date 对象，比较前落成 "YYYY-MM-DD"，
    // 否则 String(a) 会给出带时区的完整时间戳，永远匹配不上用例里写的日期字符串（T62）
    const rawA = actual[k];
    const a = rawA instanceof Date ? rawA.toISOString().slice(0, 10) : rawA;
    // 比较器形态 { lt } / { gt } / { ne }：AI 估算值不确定，只能断言方向（如"比原值低"）
    // 或排除（如"不是被继承的那个餐次"），断言不了具体值
    if (v && typeof v === "object" && ("lt" in v || "gt" in v || "ne" in v)) {
      const cmp = v as { lt?: number; gt?: number; ne?: unknown };
      const ok = (cmp.lt === undefined || Number(a) < cmp.lt)
        && (cmp.gt === undefined || Number(a) > cmp.gt)
        && (cmp.ne === undefined || String(a) !== String(cmp.ne));
      if (!ok) failures.push({ what: `${label}.${k}`, expected: cmp, actual: a });
      continue;
    }
    const ok = typeof v === "number"
      ? Math.abs(Number(a) - v) <= 0.5 // 数值容差：热量/克数按四舍五入口径比
      : String(a) === String(v);
    if (!ok) failures.push({ what: `${label}.${k}`, expected: v, actual: a });
  }
}

async function assertTurn(userId: string, turn: Turn, resp: { intent?: string; reply?: string } | null): Promise<Failure[]> {
  const failures: Failure[] = [];
  const e = turn.expect;
  if (!e) return failures;

  // 1) 意图层
  if (e.intent != null) {
    const allowed = Array.isArray(e.intent) ? e.intent : [e.intent];
    if (!resp?.intent || !allowed.includes(resp.intent)) {
      failures.push({ what: "intent", expected: allowed.join("|"), actual: resp?.intent ?? "(无响应)" });
    }
  }

  // 2) 回复红线层（结构化弱断言，不比对原文）
  // 按"用户看到的渲染后文本"匹配：去掉极简 markdown 标记（**加粗**、行首项目符号），
  // 否则加粗把数字/短语切开（如 "**2** 次"）会假阴。与前端 markdown-text 渲染同口径。
  const reply = (resp?.reply ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^[ \t]*[-·•]\s+/gm, "");
  for (const s of e.reply_contain ?? []) {
    if (!reply.includes(s)) failures.push({ what: "reply_contain", expected: s, actual: reply.slice(0, 80) });
  }
  if (e.reply_contain_any && !e.reply_contain_any.some((s) => reply.includes(s))) {
    failures.push({ what: "reply_contain_any", expected: e.reply_contain_any.join("|"), actual: reply.slice(0, 80) });
  }
  for (const pattern of e.reply_forbid ?? []) {
    if (new RegExp(pattern).test(reply)) failures.push({ what: "reply_forbid", expected: `不匹配 /${pattern}/`, actual: reply.slice(0, 80) });
  }

  // 3) 落库层（事实表，核心断言）
  const db = e.db;
  if (db?.food_record !== undefined) {
    const specs = Array.isArray(db.food_record) ? db.food_record : [db.food_record];
    for (const spec of specs) {
      const { where, ...fields } = spec;
      const rec = await prisma.foodRecord.findFirst({
        where: {
          user_id: userId,
          ...(where?.food_name ? { food: { name: { contains: where.food_name } } } : {}),
          ...(where?.meal_type ? { meal_type: where.meal_type as never } : {}),
        },
        include: { food: true },
        orderBy: { created_at: "desc" },
      });
      const label = where?.food_name
        ? `food_record(${where.food_name}${where.meal_type ? `,${where.meal_type}` : ""})`
        : "food_record";
      checkFields(failures, label, fields, rec ? { ...rec, food_name: rec.food?.name } : null);
    }
  }
  if (db?.food_record_count !== undefined) {
    const n = await prisma.foodRecord.count({ where: { user_id: userId } });
    if (n !== db.food_record_count) failures.push({ what: "food_record_count", expected: db.food_record_count, actual: n });
  }
  if (db?.exercise_record_count !== undefined) {
    const n = await prisma.exerciseRecord.count({ where: { user_id: userId } });
    if (n !== db.exercise_record_count) failures.push({ what: "exercise_record_count", expected: db.exercise_record_count, actual: n });
  }
  if (db?.exercise_record !== undefined) {
    const { where, ...fields } = db.exercise_record;
    const rec = await prisma.exerciseRecord.findFirst({
      where: {
        user_id: userId,
        ...(where?.type ? { type: { contains: where.type } } : {}),
      },
      orderBy: { created_at: "desc" },
    });
    checkFields(failures, "exercise_record", fields, rec);
  }
  if (db?.pending_record !== undefined) {
    const pending = await prisma.pendingRecord.findFirst({
      where: { user_id: userId, status: "pending" },
      orderBy: { created_at: "desc" },
    });
    if (db.pending_record === null) {
      if (pending) failures.push({ what: "pending_record", expected: "无 open pending", actual: pending.type });
    } else {
      if (!pending) failures.push({ what: "pending_record", expected: db.pending_record.type ?? "(存在)", actual: "无" });
      else if (db.pending_record.type && pending.type !== db.pending_record.type) {
        failures.push({ what: "pending_record.type", expected: db.pending_record.type, actual: pending.type });
      }
    }
  }
  if (db?.last_card !== undefined) {
    const msg = await prisma.chatMessage.findFirst({
      where: { user_id: userId, role: "assistant" },
      orderBy: { created_at: "desc" },
    });
    if (msg?.kind !== db.last_card) failures.push({ what: "last_card", expected: db.last_card, actual: msg?.kind ?? "无" });
  }
  if (db?.weight_chart !== undefined) {
    const msg = await prisma.chatMessage.findFirst({
      where: { user_id: userId, role: "assistant", kind: "weight_chart" },
      orderBy: { created_at: "desc" },
    });
    const pts = (msg?.payload as any)?.points as Array<{ kg: number }> | undefined;
    if (!pts) {
      failures.push({ what: "weight_chart", expected: "weight_chart 卡", actual: msg?.kind ?? "无" });
    } else {
      if (db.weight_chart.points !== undefined && pts.length !== db.weight_chart.points) {
        failures.push({ what: "weight_chart.points", expected: db.weight_chart.points, actual: pts.length });
      }
      for (const kg of db.weight_chart.kgs ?? []) {
        if (!pts.some((p) => Math.abs(Number(p.kg) - kg) <= 0.01)) {
          failures.push({ what: "weight_chart.kgs", expected: `含${kg}`, actual: JSON.stringify(pts.map((p) => p.kg)) });
        }
      }
    }
  }
  if (db?.weight_log !== undefined) {
    const wl = await prisma.weightLog.findFirst({ where: { user_id: userId }, orderBy: { date: "desc" } });
    if (!wl) failures.push({ what: "weight_log", expected: db.weight_log.weight_kg ?? "(存在)", actual: "无" });
    else if (db.weight_log.weight_kg !== undefined && Number(wl.weight_kg) !== db.weight_log.weight_kg) {
      failures.push({ what: "weight_log.weight_kg", expected: db.weight_log.weight_kg, actual: Number(wl.weight_kg) });
    }
  }
  for (const m of db?.memory ?? []) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT type, entity, state, valid_to FROM "UserMemory" WHERE user_id=$1 AND entity=$2` +
        (m.type ? ` AND type='${m.type}'` : ""),
      userId, m.entity,
    );
    const row = rows[0];
    if (m.absent) {
      if (row) failures.push({ what: `memory(${m.entity})`, expected: "不该建", actual: `${row.type}/${row.state}` });
      continue;
    }
    if (!row) {
      failures.push({ what: `memory(${m.entity})`, expected: m.state ?? "(存在)", actual: "无此记忆" });
      continue;
    }
    if (m.state !== undefined && row.state !== m.state) {
      failures.push({ what: `memory(${m.entity}).state`, expected: m.state, actual: row.state });
    }
    if (m.valid_to !== undefined && (row.valid_to != null) !== m.valid_to) {
      failures.push({ what: `memory(${m.entity}).valid_to`, expected: m.valid_to ? "非空" : "空", actual: row.valid_to ?? "null" });
    }
  }
  if (db?.user !== undefined) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { weight_kg: true } });
    if (db.user.weight_kg !== undefined && Number(u?.weight_kg) !== db.user.weight_kg) {
      failures.push({ what: "user.weight_kg", expected: db.user.weight_kg, actual: Number(u?.weight_kg) });
    }
  }
  return failures;
}

// ---------- 单用例执行 ----------
type TurnStatus = "PASS" | "FAIL" | "KNOWN" | "FIXED?";
interface TurnResult { label: string; status: TurnStatus; knownFail?: string; failures: Failure[] }

async function runCase(file: string): Promise<{ name: string; results: TurnResult[]; account: string }> {
  const c = parseYaml(readFileSync(file, "utf8")) as EvalCase;
  const { token, userId, account } = await registerEvalUser();
  await api("/api/user/profile", { method: "PUT", token, body: { ...DEFAULT_PROFILE, ...(c.profile ?? {}) } });
  await runSetup(userId, c.setup);

  const results: TurnResult[] = [];
  for (const turn of c.turns) {
    let label: string;
    let resp: { intent?: string; reply?: string } | null = null;
    let failures: Failure[] = [];
    try {
      if (turn.say != null) {
        label = `say "${turn.say}"`;
        resp = await api("/api/chat/message", { method: "POST", token, body: { text: turn.say } });
      } else if (turn.resolve != null) {
        label = `resolve ${JSON.stringify(turn.resolve.choice)}`;
        const pending = await prisma.pendingRecord.findFirst({
          where: { user_id: userId, status: "pending" },
          orderBy: { created_at: "desc" },
        });
        if (!pending) throw new Error("无 open pending 可 resolve（前一轮未产生卡片？）");
        await api(`/api/pending/${pending.id}/resolve`, { method: "POST", token, body: { choice: turn.resolve.choice } });
      } else {
        throw new Error("turn 必须有 say 或 resolve");
      }
      failures = await assertTurn(userId, turn, resp);
    } catch (err: any) {
      label = turn.say != null ? `say "${turn.say}"` : `resolve ${JSON.stringify(turn.resolve?.choice)}`;
      failures = [{ what: "执行异常", expected: "正常返回", actual: err?.message ?? String(err) }];
    }

    const status: TurnStatus =
      failures.length === 0
        ? turn.known_fail ? "FIXED?" : "PASS"
        : turn.known_fail ? "KNOWN" : "FAIL";
    results.push({ label, status, knownFail: turn.known_fail, failures });
  }
  return { name: c.name, results, account };
}

// ---------- 清理 ----------
async function cleanEvalUsers() {
  const users = await prisma.user.findMany({ where: { account: { startsWith: "eval_" } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return 0;
  const traces = await prisma.aiTrace.findMany({ where: { user_id: { in: ids } }, select: { id: true } });
  await prisma.aiTraceEvent.deleteMany({ where: { trace_id: { in: traces.map((t) => t.id) } } });
  await prisma.aiTrace.deleteMany({ where: { user_id: { in: ids } } });
  // 依赖顺序：bias_update_log 引用 learning_event，learning_event 引用 food_record；其余互不依赖
  for (const model of [
    prisma.biasUpdateLog, prisma.learningEvent, prisma.chatMessage, prisma.pendingRecord,
    prisma.foodRecord, prisma.exerciseRecord, prisma.dailySummary, prisma.aiParseLog,
    prisma.tokenUsage, prisma.userBias, prisma.userFoodAlias, prisma.weightLog,
  ] as Array<{ deleteMany: (a: { where: { user_id: { in: string[] } } }) => Promise<unknown> }>) {
    await model.deleteMany({ where: { user_id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

// ---------- 主流程 ----------
const ICONS: Record<TurnStatus, string> = { PASS: "✅", FAIL: "❌", KNOWN: "🟡", "FIXED?": "🎉" };

async function main() {
  const args = process.argv.slice(2);
  const caseArg = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
  const clean = args.includes("--clean");

  try {
    await api("/api/health");
  } catch {
    console.error(`后端不可达（${API}）。先 ./start.sh 启动，或设 EVAL_API_BASE。`);
    process.exit(1);
  }

  const files = readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .filter((f) => !caseArg || basename(f, ".yaml") === caseArg)
    .map((f) => join(CASES_DIR, f));
  if (files.length === 0) {
    console.error(caseArg ? `找不到用例 ${caseArg}` : "cases/ 目录为空");
    process.exit(1);
  }

  let newRegressions = 0;
  let knownFails = 0;
  for (const file of files) {
    const { name, results, account } = await runCase(file);
    console.log(`\n━━ ${basename(file, ".yaml")} — ${name}（账号 ${account}）`);
    for (const r of results) {
      console.log(`  ${ICONS[r.status]} ${r.status.padEnd(6)} ${r.label}${r.knownFail ? `  [known_fail: ${r.knownFail}]` : ""}`);
      for (const f of r.failures) {
        console.log(`       · ${f.what}: 期望 ${JSON.stringify(f.expected)}，实际 ${JSON.stringify(f.actual)}`);
      }
      if (r.status === "FAIL") newRegressions++;
      if (r.status === "KNOWN") knownFails++;
      if (r.status === "FIXED?") console.log(`       · 已知缺陷居然通过了——若 ${r.knownFail} 已修复，请删除该轮的 known_fail 标记`);
    }
  }

  console.log(`\n━━ 汇总：新回归 ${newRegressions}，已知缺陷 ${knownFails}（🟡 归属见各轮标记）`);
  if (clean) {
    const n = await cleanEvalUsers();
    console.log(`已清理 ${n} 个 eval_* 账号及其全部数据`);
  }
  await prisma.$disconnect();
  process.exit(newRegressions > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
