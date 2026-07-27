import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  extractExplicitSignals,
  hasMealAmbiguity,
  ingredientCovered,
} from "../src/services/explicit-signals";

// 对话质量审计（只读，零 LLM 调用）
//
// 目的：把"用户明说了但系统没照做"这类失败的发现路径，从"用户发火 → 立项 → 修"
// 换成"跑一遍就知道"。2026-07-27 首次全量扫描 outoftoken 401 条真实消息，
// 捞出 5 类问题，其中 2 类（宏量素修改静默改错、一句话跨两餐）此前无人投诉、
// 也不在任何任务里，已静默存在 3 周。
//
// 用法：
//   npm run audit                 全部历史
//   npm run audit -- --days 14    只看最近 14 天
//   npm run audit -- --user xxx   指定账号
//
// 重要：输出是**可疑清单，不是判决**。实测误报率约 20%，主要来自用户要求派生值
// （"不去芯340克，你算下去芯的"）和同义归一（"鸡蛋"→"水煮蛋"）。已内置抑制规则，
// 但仍需人工过一遍再立项。

type Row = {
  created_at: Date;
  intent: string | null;
  input_text: string;
  parsed_json: unknown;
  account: string;
};

type Finding = { at: Date; account: string; intent: string; text: string; detail: string };

// ── parsed_json 遍历工具 ──
function collectNumbers(o: unknown, acc: Set<number> = new Set()): Set<number> {
  if (Array.isArray(o)) o.forEach((v) => collectNumbers(v, acc));
  else if (o && typeof o === "object") Object.values(o).forEach((v) => collectNumbers(v, acc));
  else if (typeof o === "number") acc.add(o);
  return acc;
}

/** 只收 canonical——raw 是用户原话回显，拿它判"主料有没有被保留"必然全绿（首版误报即出于此） */
function collectCanonicals(o: unknown, acc: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((v) => collectCanonicals(v, acc));
  else if (o && typeof o === "object") {
    const rec = o as Record<string, unknown>;
    if (typeof rec.canonical === "string") acc.push(rec.canonical);
    Object.values(rec).forEach((v) => collectCanonicals(v, acc));
  }
  return acc;
}

function get(o: unknown, key: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;
}

const ACTIONABLE = new Set(["record", "modify", "multi", "record_weight", "resolve_pending", "resolve"]);
const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\n/g, "⏎");

async function main() {
  const args = process.argv.slice(2);
  const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : null;
  const userArg = args.includes("--user") ? args[args.indexOf("--user") + 1] : null;

  const logs = await prisma.aiParseLog.findMany({
    where: {
      ...(days ? { created_at: { gte: new Date(Date.now() - days * 86400000) } } : {}),
      user: userArg ? { account: userArg } : { account: { not: { startsWith: "eval_" } } },
    },
    select: {
      created_at: true, intent: true, input_text: true, parsed_json: true,
      user: { select: { account: true } },
    },
    orderBy: { created_at: "asc" },
  });

  const rows: Row[] = logs.map((l) => ({
    created_at: l.created_at,
    intent: l.intent,
    input_text: l.input_text,
    parsed_json: l.parsed_json,
    account: l.user.account,
  }));

  const buckets: Record<string, Finding[]> = {
    calorie: [], weight: [], date: [], instruction: [], ingredient: [], mealAmbiguity: [], macro: [],
  };
  const seen: Record<string, number> = {
    calorie: 0, weight: 0, date: 0, instruction: 0, ingredient: 0, mealAmbiguity: 0, macro: 0,
  };
  let scanned = 0;

  for (const r of rows) {
    const text = r.input_text ?? "";
    if (!text || text.startsWith("[点选卡片]")) continue;
    scanned++;

    const sig = extractExplicitSignals(text);
    const pj = r.parsed_json;
    const nums = collectNumbers(pj);
    const intent = r.intent ?? "?";
    const actionable = ACTIONABLE.has(intent);
    const base = { at: r.created_at, account: r.account, intent, text: clip(text, 52) };

    // ① 显式热量未被采纳
    if (sig.calories.length && actionable && !sig.derivedRequest) {
      seen.calorie++;
      const miss = sig.calories.filter((c) => !nums.has(c));
      if (miss.length === sig.calories.length) {
        buckets.calorie.push({ ...base, detail: `原话热量 ${miss.join("/")} 未出现在解析结果` });
      }
    }

    // ② 显式克数未被采纳
    if (sig.weights.length && actionable && !sig.derivedRequest) {
      seen.weight++;
      const miss = sig.weights.filter((w) => !nums.has(w.value));
      if (miss.length) {
        buckets.weight.push({ ...base, detail: `原话 ${miss.map((m) => m.raw).join("/")} 未落到解析结果` });
      }
    }

    // ③ 日期词未被采纳
    if (sig.dateOffset !== null && actionable) {
      seen.date++;
      const got = get(pj, "date_offset") ?? get(get(pj, "change"), "date_offset");
      if (got !== sig.dateOffset) {
        buckets.date.push({ ...base, detail: `应 date_offset=${sig.dateOffset}，实际 ${JSON.stringify(got)}` });
      }
    }

    // ④ 指令+数值未被执行
    if (sig.instructions.length) {
      seen.instruction++;
      const isModify = intent === "modify" || intent === "multi";
      const honored = isModify && sig.instructions.some((i) => nums.has(i.value));
      if (!honored) {
        buckets.instruction.push({
          ...base,
          detail: `指令 ${sig.instructions.map((i) => i.verb + i.value).join("/")} 未生效（intent=${intent}）`,
        });
      }
    }

    // ⑤ 主料被 canonical 丢弃
    if (sig.ingredients.length && (intent === "record" || intent === "multi") && !sig.derivedRequest) {
      const cans = collectCanonicals(pj);
      if (cans.length) {
        seen.ingredient++;
        const dropped = sig.ingredients.filter((w) => !ingredientCovered(w, cans));
        if (dropped.length) {
          buckets.ingredient.push({ ...base, detail: `丢 ${dropped.join("/")}｜canonical=${cans.join("+")}` });
        }
      }
    }

    // ⑥ 餐次词多信号歧义（协议限制：meal_type 是 record 级，一句跨两餐必错一个）
    if (hasMealAmbiguity(sig) && actionable) {
      seen.mealAmbiguity++;
      const kinds = [...new Set(sig.meals.map((m) => m.meal))].join("+");
      buckets.mealAmbiguity.push({
        ...base,
        detail: `同现餐次 ${kinds}，解析 meal_type=${JSON.stringify(get(pj, "meal_type"))}`,
      });
    }

    // ⑦ 宏量素修改（schema 无 protein/fat/carbs 字段 → 模型只能塞进别的字段，静默改错）
    if (/(蛋白质|脂肪|碳水)/.test(text) && /(改成|改为|记录成|应该是|不是)/.test(text)) {
      seen.macro++;
      const change = get(pj, "change");
      buckets.macro.push({
        ...base,
        detail: `intent=${intent} change=${JSON.stringify(change) ?? "无"}（协议无宏量素字段）`,
      });
    }
  }

  // ── A 轨报告 ──
  console.log("=".repeat(88));
  console.log(`对话审计 · 明示信号采纳情况    样本 ${scanned} 条真实消息` +
    (days ? `（最近 ${days} 天）` : "（全部历史）"));
  console.log("=".repeat(88));

  const table: Array<[string, keyof typeof buckets]> = [
    ["显式热量  「80卡」", "calorie"],
    ["显式克数  「850克」", "weight"],
    ["日期词    「昨天」", "date"],
    ["指令+数值 「改成850」", "instruction"],
    ["主料词    「鸡胸肉」", "ingredient"],
    ["餐次多信号（协议缺陷）", "mealAmbiguity"],
    ["宏量素修改（协议缺失）", "macro"],
  ];
  console.log(`${"信号类型".padEnd(24)}${"可判定".padStart(8)}${"可疑".padStart(8)}${"可疑率".padStart(10)}`);
  console.log("-".repeat(88));
  for (const [label, key] of table) {
    const n = seen[key], m = buckets[key].length;
    const rate = n ? `${((m / n) * 100).toFixed(1)}%` : "—";
    console.log(`${label.padEnd(24)}${String(n).padStart(8)}${String(m).padStart(8)}${rate.padStart(10)}`);
  }

  for (const [label, key] of table) {
    const items = buckets[key];
    if (!items.length) continue;
    console.log(`\n── ${label}（${items.length} 条）${"─".repeat(40)}`);
    for (const f of items.slice(0, 15)) {
      console.log(`  [${fmt(f.at)}] ${f.account}/${f.intent}`);
      console.log(`     原话: ${f.text}`);
      console.log(`     问题: ${f.detail}`);
    }
    if (items.length > 15) console.log(`  …另有 ${items.length - 15} 条`);
  }

  // ── B 轨：食物库估值健康度 ──
  console.log(`\n${"=".repeat(88)}`);
  console.log("食物库健康度");
  console.log("=".repeat(88));

  const [byKind, overrides, dupSuffix] = await Promise.all([
    prisma.foodStandard.groupBy({ by: ["is_estimated", "source"], _count: true }),
    prisma.foodRecord.findMany({
      // 必须排除 eval_* 合成账号：eval 用例会反复触发同一条覆盖（如 chunhuabing 用例的
      // 葱花饼（无油）跑一次多一条），不滤掉会把真实用户的少量样本淹没
      where: { calories_source: "user_override", user: { account: { not: { startsWith: "eval_" } } } },
      select: {
        weight_g: true, calories: true, calories_computed: true, created_at: true,
        food: { select: { name: true, calories_100g: true, is_estimated: true } },
        user: { select: { account: true } },
      },
      orderBy: { created_at: "desc" },
    }),
    prisma.$queryRaw<Array<{ name: string; calories_100g: unknown }>>`
      SELECT name, calories_100g FROM "FoodStandard" WHERE name ~ '（.*）（'
    `,
  ]);

  console.log("\n条目来源分布：");
  for (const g of byKind) {
    console.log(`  ${g.is_estimated ? "AI估算" : "成分表"} / ${g.source}：${g._count} 条`);
  }

  const recAgg = await prisma.$queryRaw<Array<{ is_estimated: boolean; n: bigint }>>`
    SELECT f.is_estimated, COUNT(*) AS n
    FROM "FoodRecord" r JOIN "FoodStandard" f ON f.id = r.food_id
    JOIN "User" u ON u.id = r.user_id
    WHERE u.account NOT LIKE 'eval_%'
    GROUP BY f.is_estimated
  `;
  const totalRec = recAgg.reduce((s, x) => s + Number(x.n), 0);
  console.log("\n真实记录命中的条目类型（估算条目一旦落库即被当作权威复用）：");
  for (const g of recAgg) {
    const n = Number(g.n);
    console.log(`  ${g.is_estimated ? "AI估算" : "成分表"}：${n} 条（${((n / totalRec) * 100).toFixed(1)}%）`);
  }

  if (overrides.length) {
    // 按食物聚合：同一食物被同一用户反复覆盖只说明这个条目一直不准，不该按次数刷屏
    // T66：calories_computed 有值就是写入当时存下的精确三元组一角，直接用；
    // 为空（存量记录，T66 上线前写入的）才回退按**当前** food_standard 反算，且标记出来别混为一谈。
    const agg = new Map<string, { n: number; exactN: number; devs: number[]; est: boolean }>();
    for (const o of overrides) {
      if (!o.food) continue;
      const exact = o.calories_computed != null;
      const sys = exact ? Number(o.calories_computed) : (Number(o.food.calories_100g) * Number(o.weight_g)) / 100;
      const usr = Number(o.calories);
      if (!(sys > 0) || !(usr > 0)) continue;
      const e = agg.get(o.food.name) ?? { n: 0, exactN: 0, devs: [], est: o.food.is_estimated };
      e.n++;
      if (exact) e.exactN++;
      e.devs.push(((sys - usr) / usr) * 100);
      agg.set(o.food.name, e);
    }
    console.log(`\n用户手动覆盖热量的食物（共 ${overrides.length} 条覆盖 / ${agg.size} 种食物）`);
    console.log("——这是食物库估值偏差目前唯一的 ground truth：");
    console.log(`  ${"食物".padEnd(26)}${"次数".padStart(6)}${"中位偏差".padStart(10)}  来源      精确度`);
    const sorted = [...agg.entries()].sort((a, b) => Math.abs(med(b[1].devs)) - Math.abs(med(a[1].devs)));
    for (const [name, e] of sorted) {
      const d = med(e.devs);
      const precision = e.exactN === e.n ? "精确" : e.exactN === 0 ? "反算" : `${e.exactN}/${e.n}精确`;
      console.log(
        `  ${name.slice(0, 24).padEnd(26)}${String(e.n).padStart(6)}` +
        `${((d >= 0 ? "+" : "") + d.toFixed(0) + "%").padStart(10)}  ${e.est ? "AI估算" : "成分表"}    ${precision}`,
      );
    }
    console.log("  正偏差=系统高估（用户往下改），负偏差=系统低估。");
    console.log("  「精确」= calories_computed 写入时存下的当时系统值（T66）；「反算」= T66 上线前的存量记录，按**当前** food_standard 反算，条目若事后被改过则不准。");
  } else {
    console.log("\n暂无 user_override 记录——食物库偏差无 ground truth 可用。");
  }

  if (dupSuffix.length) {
    console.log("\n⚠️ 属性后缀重复叠加的条目（modify.food_desc 反复修正所致）：");
    for (const d of dupSuffix) console.log(`  ${d.name}（${Math.round(Number(d.calories_100g))} kcal/100g）`);
  }

  console.log("\n" + "=".repeat(88));
  console.log("提醒：以上为**可疑清单**，非判决。实测误报约 20%（派生值请求、同义归一），请人工复核后再立项。");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
