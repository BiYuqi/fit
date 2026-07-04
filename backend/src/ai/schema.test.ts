import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureChosenPortion, ParseResultSchema, type FoodItem } from "./schema";

// T42 护栏：chosen_label 在 portions 中无对应条目时的归一化

function makeItem(over: Partial<FoodItem> = {}): FoodItem {
  return {
    raw: "100克葱花饼 煎的",
    canonical: "葱花饼",
    quantity_expr: "100克",
    portions: [
      { label: "small", grams: 80, unit: "g" },
      { label: "medium", grams: 120, unit: "g" },
      { label: "large", grams: 160, unit: "g" },
    ],
    chosen_label: "custom",
    food_confidence: 0.95,
    portion_confidence: 0.95,
    is_ambiguous: false,
    ...over,
  };
}

test("chosen=custom 缺档 + quantity_expr 有克数 → 补 custom 条目，克数=用户明示值", () => {
  const out = ensureChosenPortion(makeItem());
  assert.equal(out.chosen_label, "custom");
  const custom = out.portions.find((p) => p.label === "custom");
  assert.ok(custom);
  assert.equal(custom.grams, 100);
  assert.equal(custom.unit, "g");
});

test("毫升表达 → custom 条目 unit=ml", () => {
  const out = ensureChosenPortion(makeItem({ quantity_expr: "200ml" }));
  const custom = out.portions.find((p) => p.label === "custom");
  assert.ok(custom);
  assert.equal(custom.grams, 200);
  assert.equal(custom.unit, "ml");
});

test("中文单位毫升与小数克数均可提取", () => {
  const out = ensureChosenPortion(makeItem({ quantity_expr: "250毫升" }));
  assert.equal(out.portions.find((p) => p.label === "custom")?.unit, "ml");
  const out2 = ensureChosenPortion(makeItem({ quantity_expr: "37.5克" }));
  assert.equal(out2.portions.find((p) => p.label === "custom")?.grams, 37.5);
});

test("缺档且提不出数量 → chosen 回退 medium（绝不回退小份）", () => {
  const out = ensureChosenPortion(makeItem({ quantity_expr: "一碗" }));
  assert.equal(out.chosen_label, "medium");
  assert.equal(out.portions.length, 3); // 不新增条目
});

test("缺档、无数量、且无 medium 档 → 回退首个存在档", () => {
  const out = ensureChosenPortion(
    makeItem({
      quantity_expr: "一些",
      portions: [{ label: "large", grams: 160, unit: "g" }],
    }),
  );
  assert.equal(out.chosen_label, "large");
});

test("chosen_label 档位存在 → 原样返回，不做任何改动", () => {
  const item = makeItem({
    portions: [{ label: "custom", grams: 100, unit: "g" }],
  });
  const out = ensureChosenPortion(item);
  assert.deepEqual(out, item);
});

test("ParseResultSchema 解析 record 时自动归一化 items（葱花饼 bug 现场形态）", () => {
  const parsed = ParseResultSchema.parse({
    intent: "record",
    meal_type: "dinner",
    items: [makeItem()],
  });
  assert.equal(parsed.intent, "record");
  if (parsed.intent === "record") {
    const custom = parsed.items?.[0].portions.find((p) => p.label === "custom");
    assert.equal(custom?.grams, 100);
  }
});

// T40：modify.update change.calories / change.food_desc 的 zod 校验

test("modify.update change.calories 合法解析（用户直接指定热量）", () => {
  const parsed = ParseResultSchema.parse({
    intent: "modify", action: "update", target: "r1",
    change: { calories: 180 },
  });
  if (parsed.intent === "modify") {
    assert.equal(parsed.change?.calories, 180);
  }
});

test("modify.update change.food_desc 合法解析（属性修正）", () => {
  const parsed = ParseResultSchema.parse({
    intent: "modify", action: "update", target: "r1",
    change: { food_desc: "无油" },
  });
  if (parsed.intent === "modify") {
    assert.equal(parsed.change?.food_desc, "无油");
  }
});

test("change.calories 非正数拒绝（0 或负数不是合法热量）", () => {
  assert.throws(() => ParseResultSchema.parse({
    intent: "modify", action: "update", target: "r1",
    change: { calories: 0 },
  }));
  assert.throws(() => ParseResultSchema.parse({
    intent: "modify", action: "update", target: "r1",
    change: { calories: -50 },
  }));
});

test("change.food_desc 空字符串拒绝", () => {
  assert.throws(() => ParseResultSchema.parse({
    intent: "modify", action: "update", target: "r1",
    change: { food_desc: "" },
  }));
});

test("change 可省略 calories/food_desc，不影响其余字段解析（向后兼容）", () => {
  const parsed = ParseResultSchema.parse({
    intent: "modify", action: "update", target: "r1",
    change: { grams: 150, portion_label: "medium" },
  });
  if (parsed.intent === "modify") {
    assert.equal(parsed.change?.calories, undefined);
    assert.equal(parsed.change?.food_desc, undefined);
  }
});

test("ParseResultSchema 解析 modify.append 的 items 同样归一化", () => {
  const parsed = ParseResultSchema.parse({
    intent: "modify",
    action: "append",
    target: "r1",
    items: [makeItem({ quantity_expr: "80克", chosen_label: "custom" })],
  });
  if (parsed.intent === "modify") {
    const custom = parsed.items?.[0].portions.find((p) => p.label === "custom");
    assert.equal(custom?.grams, 80);
  }
});
