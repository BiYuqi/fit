import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractMealTypeFromText } from "./dates";

// T68：extractMealTypeFromText 此前零测试覆盖——先锁住单信号现状（改前行为），
// 再加多信号用例（这是本任务要改的部分：多类别时段词同现时不再武断取第一个命中）。

test("extractMealTypeFromText — 单信号：breakfast 各词形", () => {
  assert.equal(extractMealTypeFromText("早上吃了个包子"), "breakfast");
  assert.equal(extractMealTypeFromText("早晨的粥"), "breakfast");
  assert.equal(extractMealTypeFromText("早饭吃了面"), "breakfast");
  assert.equal(extractMealTypeFromText("早餐一个鸡蛋"), "breakfast");
  assert.equal(extractMealTypeFromText("上午吃了个苹果"), "breakfast");
});

test("extractMealTypeFromText — 单信号：lunch 各词形", () => {
  assert.equal(extractMealTypeFromText("中午吃了米饭"), "lunch");
  assert.equal(extractMealTypeFromText("午饭吃了面条"), "lunch");
  assert.equal(extractMealTypeFromText("午餐一份沙拉"), "lunch");
  assert.equal(extractMealTypeFromText("中饭吃了牛肉"), "lunch");
});

test("extractMealTypeFromText — 单信号：dinner 各词形", () => {
  assert.equal(extractMealTypeFromText("晚上吃了牛排"), "dinner");
  assert.equal(extractMealTypeFromText("晚饭吃了鱼"), "dinner");
  assert.equal(extractMealTypeFromText("晚餐一份沙拉"), "dinner");
  assert.equal(extractMealTypeFromText("傍晚吃了点水果"), "dinner");
});

test("extractMealTypeFromText — 单信号：snack 各词形", () => {
  assert.equal(extractMealTypeFromText("下午茶吃了蛋糕"), "snack");
  assert.equal(extractMealTypeFromText("下午吃了个橙子"), "snack");
  assert.equal(extractMealTypeFromText("加餐吃了坚果"), "snack");
  assert.equal(extractMealTypeFromText("零食吃了薯片"), "snack");
});

test("extractMealTypeFromText — 同一类别多次命中仍算单信号", () => {
  assert.equal(extractMealTypeFromText("早上7点和上午10点各吃了一次包子"), "breakfast");
});

test("extractMealTypeFromText — 无时段词返回 null（等价现状）", () => {
  assert.equal(extractMealTypeFromText("吃了个包子"), null);
});

test("extractMealTypeFromText — 多类别时段词同现，返回 null 承认歧义（T68 核心改动）", () => {
  assert.equal(extractMealTypeFromText("早晨的饼 晚上又吃了200克"), null);
  assert.equal(
    extractMealTypeFromText("昨晚晚餐一个200毫升牛奶，昨天中午的干豆角炖土豆250克"),
    null,
  );
});
