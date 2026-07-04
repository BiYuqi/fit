import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildMealCardView,
  upsertMealCardMessage,
  enrichMealCards,
  refreshMealCard,
  type MealCardDb,
  type MealCardRecord,
} from "./meal-card";

// upsert 结果非空断言（createIfMissing 默认 true 的路径不可能返回 null）
function must<T>(v: T | null): T {
  assert.ok(v !== null);
  return v;
}

// ═══ fake db：内存 chat_message 表，模拟 upsert 用到的 jsonb 路径查询 ═══

function jsonPath(row: any, cond: any): boolean {
  const { path, equals } = cond.payload;
  let v = row.payload;
  for (const p of path) v = v?.[p];
  return v === equals;
}

function fakeDb(foodRecords: any[] = []): MealCardDb & { rows: any[] } {
  const rows: any[] = [];
  let seq = 0;
  return {
    rows,
    chatMessage: {
      async findFirst(args: any) {
        const w = args.where ?? {};
        return (
          rows.find(
            (r) =>
              (w.user_id === undefined || r.user_id === w.user_id) &&
              (w.kind === undefined || r.kind === w.kind) &&
              (w.AND === undefined || w.AND.every((c: any) => jsonPath(r, c))),
          ) ?? null
        );
      },
      async create(args: any) {
        const row = { id: `msg-${++seq}`, created_at: new Date(), ...args.data };
        rows.push(row);
        return row;
      },
      async update(args: any) {
        const row = rows.find((r) => r.id === args.where.id);
        Object.assign(row, args.data);
        return row;
      },
    },
    foodRecord: {
      async findMany(args: any) {
        const w = args.where ?? {};
        return foodRecords.filter(
          (r) =>
            r.user_id === w.user_id &&
            r.date.getTime() === w.date.getTime() &&
            r.meal_type === w.meal_type,
        );
      },
    },
  };
}

const rec = (over: Partial<MealCardRecord & { user_id: string; date: Date; meal_type: string }> = {}) => ({
  id: "r1",
  user_id: "u1",
  date: new Date("2026-07-04T00:00:00.000Z"),
  meal_type: "lunch",
  raw_input: "米饭一碗",
  weight_g: 200,
  calories: 232.4,
  protein: 5.2,
  fat: 0.6,
  carbs: 51.4,
  portion_label: "medium",
  food: { name: "米饭", is_estimated: false },
  ...over,
});

// ═══ upsertMealCardMessage：幂等 + 卡片跟随 ═══

test("upsert 幂等：同餐两次调用返回同一消息 id，且只存在一条消息", async () => {
  const db = fakeDb();
  const p = { user_id: "u1", mealDate: "2026-07-04", meal_type: "lunch" as const, chatDate: new Date("2026-07-04T00:00:00.000Z") };
  const first = must(await upsertMealCardMessage(p, db));
  const t1 = first.message.created_at;
  await new Promise((r) => setTimeout(r, 5));
  const second = must(await upsertMealCardMessage(p, db));

  assert.equal(second.message.id, first.message.id);
  assert.equal(db.rows.length, 1);
  // 卡片跟随：第二次调用 bump created_at
  assert.ok(second.message.created_at.getTime() > t1.getTime());
});

test("upsert 分组键 = 日期 + 餐次：不同餐 / 不同日各自一张卡", async () => {
  const db = fakeDb();
  const base = { user_id: "u1", chatDate: new Date("2026-07-04T00:00:00.000Z") };
  const lunch = must(await upsertMealCardMessage({ ...base, mealDate: "2026-07-04", meal_type: "lunch" }, db));
  const dinner = must(await upsertMealCardMessage({ ...base, mealDate: "2026-07-04", meal_type: "dinner" }, db));
  const nextDay = must(await upsertMealCardMessage({ ...base, mealDate: "2026-07-05", meal_type: "lunch" }, db));

  assert.equal(db.rows.length, 3);
  assert.notEqual(lunch.message.id, dinner.message.id);
  assert.notEqual(lunch.message.id, nextDay.message.id);
});

test("upsert isFirst：仅用户第一张 meal_card 为 true（首次引导提示只出现一次）", async () => {
  const db = fakeDb();
  const base = { user_id: "u1", chatDate: new Date("2026-07-04T00:00:00.000Z") };
  const first = must(await upsertMealCardMessage({ ...base, mealDate: "2026-07-04", meal_type: "lunch" }, db));
  const sameMeal = must(await upsertMealCardMessage({ ...base, mealDate: "2026-07-04", meal_type: "lunch" }, db));
  const otherMeal = must(await upsertMealCardMessage({ ...base, mealDate: "2026-07-04", meal_type: "dinner" }, db));

  assert.equal(first.isFirst, true);
  assert.equal(sameMeal.isFirst, false);
  assert.equal(otherMeal.isFirst, false);
});

test("upsert 落库 payload 只存组装键：meal_key + last_change:null，无明细快照", async () => {
  const db = fakeDb();
  const { message } = must(await upsertMealCardMessage(
    { user_id: "u1", mealDate: "2026-07-04", meal_type: "lunch", chatDate: new Date("2026-07-04T00:00:00.000Z") },
    db,
  ));
  assert.deepEqual(message.payload, {
    meal_key: { date: "2026-07-04", meal_type: "lunch" },
    last_change: null,
  });
});

// ═══ T47：last_change 单槽撤销信息 + createIfMissing ═══

test("last_change：写入 → 再次修改覆盖 → null 清除；undefined 不动现有值", async () => {
  const db = fakeDb();
  const base = { user_id: "u1", mealDate: "2026-07-04", meal_type: "lunch" as const, chatDate: new Date("2026-07-04T00:00:00.000Z") };

  const c1 = must(await upsertMealCardMessage({ ...base, lastChange: { record_id: "r1", prev_state: { weight_g: 100 } } }, db));
  assert.deepEqual(c1.message.payload.last_change, { record_id: "r1", prev_state: { weight_g: 100 } });

  // 再次修改覆盖（单槽）
  const c2 = must(await upsertMealCardMessage({ ...base, lastChange: { record_id: "r2" } }, db));
  assert.deepEqual(c2.message.payload.last_change, { record_id: "r2" });
  assert.deepEqual(c2.message.payload.meal_key, { date: "2026-07-04", meal_type: "lunch" }, "组装键不被覆盖");

  // undefined：纯 bump，不动 last_change
  const c3 = must(await upsertMealCardMessage(base, db));
  assert.deepEqual(c3.message.payload.last_change, { record_id: "r2" });

  // null：撤销已消费 → 清除
  const c4 = must(await upsertMealCardMessage({ ...base, lastChange: null }, db));
  assert.equal(c4.message.payload.last_change, null);
});

test("createIfMissing:false：无卡时返回 null 且不建卡（删除/撤销不给 pre-T46 的餐造卡）", async () => {
  const db = fakeDb();
  const r = await upsertMealCardMessage(
    { user_id: "u1", mealDate: "2026-07-04", meal_type: "lunch", chatDate: new Date("2026-07-04T00:00:00.000Z"), createIfMissing: false },
    db,
  );
  assert.equal(r, null);
  assert.equal(db.rows.length, 0);
});

test("refreshMealCard：upsert + 组装 + 按 id 去重，卡片始终落在 messages 末尾", async () => {
  const db = fakeDb([rec({ id: "r1" })]);
  const base = { user_id: "u1", mealDate: "2026-07-04", meal_type: "lunch" as const, chatDate: new Date("2026-07-04T00:00:00.000Z") };
  const messages: object[] = [{ id: "m-text", kind: "text" }];

  const first = must(await refreshMealCard(messages, base, db));
  assert.equal((first.message.payload as any).items.length, 1);
  assert.equal(messages.length, 2);

  // 同一响应内第二次刷新（multi 多 op 触同一餐）：不重复，旧的被替换、新组装态在末尾
  const again = must(await refreshMealCard(messages, base, db));
  assert.equal(messages.length, 2);
  assert.equal((messages[1] as any).id, again.message.id);
  assert.equal((messages[0] as any).id, "m-text");
});

// ═══ buildMealCardView / enrichMealCards：实时组装 + 求和 ═══

test("buildMealCardView 求和正确：totals = 各项取整后之和，卡内自洽", () => {
  const view = buildMealCardView([
    rec({ id: "r1", calories: 232.4, protein: 5.2, fat: 0.6, carbs: 51.4 }),
    rec({ id: "r2", calories: 165.6, protein: 31.0, fat: 3.6, carbs: 0, raw_input: "鸡胸肉", food: { name: "鸡胸肉", is_estimated: false } }),
  ] as MealCardRecord[]);

  assert.equal(view.item_count, 2);
  assert.deepEqual(view.totals, {
    calories: 232 + 166,
    protein_g: 5 + 31,
    fat_g: 1 + 4,
    carbs_g: 51 + 0,
  });
  // 明细主显示 raw_input，food_name/weight_g 作兜底
  assert.equal(view.items[0].raw_input, "米饭一碗");
  assert.equal(view.items[0].food_name, "米饭");
  assert.equal(view.items[0].record_id, "r1");
});

test("enrichMealCards：meal_card 按 meal_key 从 food_record 实时组装，非 meal_card 原样透传", async () => {
  const db = fakeDb([
    rec({ id: "r1" }),
    rec({ id: "r2", meal_type: "dinner" }), // 别的餐，不该混进来
    rec({ id: "r3", user_id: "u2" }), // 别的用户
  ]);
  const cardMsg = {
    id: "m1", kind: "meal_card", user_id: "u1",
    payload: { meal_key: { date: "2026-07-04", meal_type: "lunch" }, last_change: null },
  };
  const textMsg = { id: "m2", kind: "text", user_id: "u1", payload: null };

  const [card, text] = await enrichMealCards([cardMsg, textMsg], db);

  assert.equal((card.payload as any).items.length, 1);
  assert.equal((card.payload as any).items[0].record_id, "r1");
  assert.equal((card.payload as any).item_count, 1);
  // 组装键保留（前端/下次组装还要用）
  assert.deepEqual((card.payload as any).meal_key, { date: "2026-07-04", meal_type: "lunch" });
  assert.equal(text, textMsg);
});

test("enrichMealCards 空餐（记录全删光）返回 items:[]，totals 全 0", async () => {
  const db = fakeDb([]);
  const cardMsg = {
    id: "m1", kind: "meal_card", user_id: "u1",
    payload: { meal_key: { date: "2026-07-04", meal_type: "lunch" }, last_change: null },
  };
  const [card] = await enrichMealCards([cardMsg], db);

  assert.deepEqual((card.payload as any).items, []);
  assert.equal((card.payload as any).item_count, 0);
  assert.deepEqual((card.payload as any).totals, { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 });
});
