import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QueryPlanSchema,
  resolveRange,
  renderQueryResult,
  RANGE_MAX_DAYS,
  ITEMS_MAX,
  DAILY_MAX_DAYS,
  type QueryPlan,
  type QueryRows,
  type FoodRow,
} from "./query-plan";

// T44 查询计划：纯函数（区间解析/渲染）+ schema 安全边界 + 源码扫描只读护栏

// ---------- resolveRange ----------
// 2026-07-04 是周六（getUTCDay()=6）

test("resolveRange: 符号区间按今天确定性解析", () => {
  const today = "2026-07-04";
  assert.deepEqual(resolveRange({ type: "today" }, today), { from: "2026-07-04", to: "2026-07-04", days: 1, note: undefined });
  assert.deepEqual(resolveRange({ type: "yesterday" }, today)!.from, "2026-07-03");
  // 周一起算：本周 = 6/29(周一)~今天
  assert.deepEqual(resolveRange({ type: "this_week" }, today), { from: "2026-06-29", to: "2026-07-04", days: 6, note: undefined });
  // 上周 = 6/22(周一)~6/28(周日)
  assert.deepEqual(resolveRange({ type: "last_week" }, today), { from: "2026-06-22", to: "2026-06-28", days: 7, note: undefined });
  assert.deepEqual(resolveRange({ type: "this_month" }, today), { from: "2026-07-01", to: "2026-07-04", days: 4, note: undefined });
  assert.deepEqual(resolveRange({ type: "last_month" }, today), { from: "2026-06-01", to: "2026-06-30", days: 30, note: undefined });
  assert.deepEqual(resolveRange({ type: "last_n_days", n: 7 }, today), { from: "2026-06-28", to: "2026-07-04", days: 7, note: undefined });
});

test("resolveRange: 周一当天 this_week 只含今天，last_week 是完整上一周", () => {
  const monday = "2026-06-29";
  assert.deepEqual(resolveRange({ type: "this_week" }, monday), { from: "2026-06-29", to: "2026-06-29", days: 1, note: undefined });
  assert.deepEqual(resolveRange({ type: "last_week" }, monday), { from: "2026-06-22", to: "2026-06-28", days: 7, note: undefined });
});

test("resolveRange: 跨月/跨年边界", () => {
  // 1月1日的 last_month 是去年12月
  assert.deepEqual(resolveRange({ type: "last_month" }, "2026-01-01"), { from: "2025-12-01", to: "2025-12-31", days: 31, note: undefined });
  // 月初 this_month 只含 1 天
  assert.equal(resolveRange({ type: "this_month" }, "2026-07-01")!.days, 1);
});

test("resolveRange: 未来日期拒绝，尾部伸进未来的截到今天", () => {
  const today = "2026-07-04";
  assert.equal(resolveRange({ type: "day", date: "2026-07-05" }, today), null);
  assert.equal(resolveRange({ type: "range", from: "2026-08-01", to: "2026-08-10" }, today), null);
  const r = resolveRange({ type: "range", from: "2026-07-01", to: "2026-07-10" }, today)!;
  assert.equal(r.to, "2026-07-04");
});

test("resolveRange: 区间超上限截取并附说明；from/to 颠倒自动纠正", () => {
  const today = "2026-07-04";
  const r = resolveRange({ type: "range", from: "2025-01-01", to: "2026-07-04" }, today)!;
  assert.equal(r.days, RANGE_MAX_DAYS);
  assert.ok(r.note?.includes(`${RANGE_MAX_DAYS}天`));
  const swapped = resolveRange({ type: "range", from: "2026-07-03", to: "2026-07-01" }, today)!;
  assert.equal(swapped.from, "2026-07-01");
  assert.equal(swapped.to, "2026-07-03");
});

// ---------- QueryPlanSchema 安全边界 ----------

test("QueryPlanSchema: 越权不可表达——多余字段（user_id 等）直接拒绝", () => {
  const base = { range: { type: "yesterday" }, detail: "items" };
  assert.ok(QueryPlanSchema.safeParse(base).success);
  assert.equal(QueryPlanSchema.safeParse({ ...base, user_id: "someone-else" }).success, false);
  assert.equal(QueryPlanSchema.safeParse({ ...base, table: "chat_message" }).success, false);
  assert.equal(QueryPlanSchema.safeParse({ ...base, range: { type: "yesterday", sql: "drop" } }).success, false);
});

test("QueryPlanSchema: last_n_days 的 n 有硬上限，非法枚举拒绝", () => {
  assert.equal(QueryPlanSchema.safeParse({ range: { type: "last_n_days", n: 10000 }, detail: "total" }).success, false);
  assert.equal(QueryPlanSchema.safeParse({ range: { type: "yesterday" }, detail: "everything" }).success, false);
  assert.equal(QueryPlanSchema.safeParse({ range: { type: "day", date: "昨天" }, detail: "items" }).success, false);
});

// ---------- renderQueryResult ----------

const R = { from: "2026-07-03", to: "2026-07-03", days: 1, note: undefined };

function food(over: Partial<FoodRow>): FoodRow {
  return { date: "2026-07-03", name: "米饭", grams: 200, calories: 232, protein: 5, fat: 1, carbs: 52, meal_type: "lunch", ...over };
}
function rows(over: Partial<QueryRows>): QueryRows {
  return { foods: [], exercises: [], summaries: [], ...over };
}

test("render items: 明细带餐次与热量，food_filter 给次数行", () => {
  const plan: QueryPlan = QueryPlanSchema.parse({ range: { type: "yesterday" }, detail: "items", food_filter: "红烧肉" });
  const out = renderQueryResult(plan, R, rows({
    foods: [food({ name: "红烧肉", grams: 150, calories: 300, meal_type: "dinner" }), food({ name: "红烧肉", grams: 100, calories: 200, meal_type: "lunch" })],
  }));
  assert.ok(out.includes("「红烧肉」共2次"));
  assert.ok(out.includes("晚餐·红烧肉 150g(约300kcal)"));
  assert.ok(out.includes("午餐·红烧肉 100g(约200kcal)"));
});

test("render items: 超上限折叠", () => {
  const plan: QueryPlan = QueryPlanSchema.parse({ range: { type: "last_n_days", n: 30 }, detail: "items" });
  const many = Array.from({ length: ITEMS_MAX + 10 }, (_, i) => food({ name: `食物${i}` }));
  const out = renderQueryResult(plan, { ...R, days: 30 }, rows({ foods: many }));
  assert.ok(out.includes("另有10条已折叠"));
});

test("render daily: summary 优先带目标，无 summary 天由明细聚合兜底，统计行在场", () => {
  const plan: QueryPlan = QueryPlanSchema.parse({ range: { type: "last_n_days", n: 3 }, detail: "daily" });
  const out = renderQueryResult(plan, { from: "2026-07-01", to: "2026-07-03", days: 3, note: undefined }, rows({
    summaries: [{ date: "2026-07-01", calories_in: 1800, protein: 90, fat: 60, carbs: 200, deficit: 100, target_calories: 1600 }],
    foods: [
      food({ date: "2026-07-02", calories: 500, protein: 20 }),
      food({ date: "2026-07-02", calories: 300, protein: 10 }),
    ],
  }));
  assert.ok(out.includes("2026-07-01 摄入1800kcal"), out);
  assert.ok(out.includes("目标1600kcal"));
  assert.ok(out.includes("实际缺口100kcal")); // summary 天带缺口（与今日卡同词）
  assert.ok(out.includes("2026-07-02 摄入800kcal 蛋白30g")); // 同一天两条明细正确累加
  assert.ok(!out.includes("2026-07-02 摄入800kcal 蛋白30g 脂肪1g 碳水52g 实际缺口")); // food 兜底天无缺口
  assert.ok(out.includes("统计：记录2天"));
  assert.ok(out.includes("日均摄入1300kcal"));
  assert.ok(out.includes("平均缺口100kcal")); // 仅 07-01 有 summary，均值=100
  assert.ok(out.includes("超目标1天/1天")); // 1800 > 1600，仅 summary 天有目标
});

test("render daily: 区间超上限降为总量+统计", () => {
  const plan: QueryPlan = QueryPlanSchema.parse({ range: { type: "range", from: "2026-04-01", to: "2026-06-30" }, detail: "daily" });
  const out = renderQueryResult(plan, { from: "2026-04-01", to: "2026-06-30", days: 91, note: undefined }, rows({ foods: [food({ date: "2026-05-01" })] }));
  assert.ok(out.includes(`区间超${DAILY_MAX_DAYS}天`));
  assert.ok(out.includes("总摄入232kcal"));
});

test("render total/by_food/report", () => {
  const data = rows({
    foods: [
      food({ date: "2026-07-01", name: "红烧肉", calories: 300 }),
      food({ date: "2026-07-02", name: "红烧肉", calories: 200 }),
      food({ date: "2026-07-02", name: "米饭", calories: 232 }),
    ],
    exercises: [{ date: "2026-07-02", type: "跑步", duration_min: 30, calories: 280 }],
  });
  const range = { from: "2026-07-01", to: "2026-07-03", days: 3, note: undefined };

  const total = renderQueryResult(QueryPlanSchema.parse({ range: { type: "last_n_days", n: 3 }, detail: "total" }), range, data);
  assert.ok(total.includes("总摄入732kcal"));
  assert.ok(total.includes("共3条食物记录"));
  assert.ok(total.includes("运动共1次 消耗280kcal"));

  const byFood = renderQueryResult(QueryPlanSchema.parse({ range: { type: "last_n_days", n: 3 }, detail: "by_food" }), range, data);
  assert.ok(byFood.includes("红烧肉 ×2次 共500kcal"));

  const report = renderQueryResult(QueryPlanSchema.parse({ range: { type: "last_n_days", n: 3 }, detail: "report" }), range, data);
  assert.ok(report.includes("统计：记录2天"));
  assert.ok(report.includes("常吃Top2"));
});

test("render total 缺口：单日给实际缺口，多天给合计+平均缺口", () => {
  // 单日"昨天有没有缺口" → detail=total，summary 覆盖 → 实际缺口
  const oneDay = renderQueryResult(
    QueryPlanSchema.parse({ range: { type: "yesterday" }, detail: "total" }),
    R,
    rows({
      foods: [food({ calories: 2007 })],
      summaries: [{ date: "2026-07-03", calories_in: 2007, protein: 107, fat: 62, carbs: 258, deficit: -257, target_calories: 1750 }],
    }),
  );
  assert.ok(oneDay.includes("实际缺口-257kcal"), oneDay); // 缺口为负=超支，如实给数
  assert.ok(!oneDay.includes("合计缺口")); // 单日不给合计

  const multi = renderQueryResult(
    QueryPlanSchema.parse({ range: { type: "last_n_days", n: 2 }, detail: "total" }),
    { from: "2026-07-02", to: "2026-07-03", days: 2, note: undefined },
    rows({
      foods: [food({ date: "2026-07-02" }), food({ date: "2026-07-03" })],
      summaries: [
        { date: "2026-07-02", calories_in: 1800, protein: 90, fat: 60, carbs: 200, deficit: 100, target_calories: 1600 },
        { date: "2026-07-03", calories_in: 2007, protein: 107, fat: 62, carbs: 258, deficit: -257, target_calories: 1750 },
      ],
    }),
  );
  assert.ok(multi.includes("合计缺口-157kcal"), multi); // 100 + (-257)
  assert.ok(multi.includes("平均缺口-78kcal")); // Math.round(-78.5) = -78（向 +∞ 取整）
});

test("render: 空结果明确说没有记录（含过滤条件回显）", () => {
  const plan: QueryPlan = QueryPlanSchema.parse({ range: { type: "yesterday" }, detail: "items", food_filter: "红烧肉", meal_filter: "dinner" });
  const out = renderQueryResult(plan, R, rows({}));
  assert.ok(out.includes("没有任何记录"));
  assert.ok(out.includes("红烧肉"));
  assert.ok(out.includes("晚餐"));
});

// ---------- 只读护栏：源码扫描 ----------
// 执行器所在文件不允许出现任何写操作与白名单外的表。比人肉 review 便宜的机械兜底。

test("query-plan.ts 源码：无写路径、chat_message 不可达", () => {
  const src = readFileSync(join(__dirname, "query-plan.ts"), "utf8");
  for (const forbidden of ["chatMessage", ".create(", ".update(", ".upsert(", ".delete", ".executeRaw", "$queryRaw"]) {
    assert.ok(!src.includes(forbidden), `query-plan.ts 不应出现 "${forbidden}"`);
  }
  // prisma 访问只允许三张白名单表
  const tables = [...src.matchAll(/prisma\.(\w+)\./g)].map((m) => m[1]);
  for (const t of tables) {
    assert.ok(["foodRecord", "exerciseRecord", "dailySummary"].includes(t), `白名单外的表访问: prisma.${t}`);
  }
});
