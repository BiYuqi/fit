import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResolveLogData, CARD_INPUT_TEXT } from "./resolve-log";

// T37：resolve 三分支写 ai_parse_log 的数据构建

test("portion_choice：reply_summary 含食物/中文份量/克数，parsed_json 带指代锚点", () => {
  const d = buildResolveLogData("u1", {
    action: "portion_choice", food_name: "煎饼果子", portion_label: "medium", grams: 450,
  });
  assert.equal(d.user_id, "u1");
  assert.equal(d.input_text, CARD_INPUT_TEXT);
  assert.equal(d.intent, "resolve");
  assert.equal(d.status, "resolved");
  assert.equal(d.reply_summary, "确认：煎饼果子 中份 450g");
  assert.deepEqual(d.parsed_json, {
    action: "portion_choice", food_name: "煎饼果子", portion_label: "medium", grams: 450,
  });
});

test("portion_choice：custom 克数与非整数克数（四舍五入）", () => {
  const d = buildResolveLogData("u1", {
    action: "portion_choice", food_name: "米饭", portion_label: "custom", grams: 123.4,
  });
  assert.equal(d.reply_summary, "确认：米饭 自定 123g");
});

test("food_choice：候选卡选定食物，摘要标明待确认份量", () => {
  const d = buildResolveLogData("u1", { action: "food_choice", food_name: "煎饼果子" });
  assert.equal(d.intent, "resolve");
  assert.equal(d.reply_summary, "已选「煎饼果子」，待确认份量");
  assert.deepEqual(d.parsed_json, { action: "food_choice", food_name: "煎饼果子" });
});

test("delete_confirm：摘要为已删除+名称，parsed_json 保留 record_id", () => {
  const d = buildResolveLogData("u1", {
    action: "delete_confirm", name: "牛肉面", record_id: "rid-1", kind: "food",
  });
  assert.equal(d.reply_summary, "已删除：牛肉面");
  assert.deepEqual(d.parsed_json, {
    action: "delete_confirm", name: "牛肉面", record_id: "rid-1", kind: "food",
  });
});

test("未知 portion_label 原样输出（不因缺映射崩掉）", () => {
  const d = buildResolveLogData("u1", {
    action: "portion_choice", food_name: "米饭", portion_label: "xl", grams: 600,
  });
  assert.equal(d.reply_summary, "确认：米饭 xl 600g");
});
