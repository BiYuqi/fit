import { test } from "node:test";
import assert from "node:assert/strict";
import { compressContext } from "./ctx";
import type { MemoryPack } from "../services/memory";

// T36：compressContext 输出【本周】【本月】聚合行 + L0 相对时间前缀

function makePack(over: Partial<MemoryPack> = {}): MemoryPack {
  return {
    profile: {
      gender: "male",
      age: 30,
      height_cm: 175,
      weight_kg: 70,
      target_weight_kg: 65,
      latest_weight_kg: null,
      latest_weight_date: null,
      goal_type: "cut",
      daily_deficit: 500,
      activity_level: "moderate",
    },
    card: {
      today: { in: 1320, out: 1900, deficit: 580, p: 70, f: 40, c: 150, remaining: 280 },
      yesterday: { in: 1500, deficit: 400, p: 80, f: 50, c: 160 },
      week: { avg_deficit: 450, logged_days: 6 },
      month: { logged_days: 23, avg_in: 1400 },
      targets: { calories: 1600, protein: 110 },
    },
    recent_records: [],
    recent_turns: [],
    recent_days: [],
    portion_habits: [],
    pending: null,
    ...over,
  };
}

test("compressContext 输出【本周】【本月】行（数据取自 card.week / card.month）", () => {
  const out = compressContext(makePack());
  assert.match(out, /【本周】平均缺口450kcal 已记录6天/);
  assert.match(out, /【本月】平均摄入1400kcal 已记录23天/);
});

test("compressContext 有实测体重点时【用户档案】区分初始体重与最新实测体重（T51）", () => {
  const withWeight = makePack();
  withWeight.profile.latest_weight_kg = 77.75;
  withWeight.profile.latest_weight_date = "2026-07-05";
  const out = compressContext(withWeight);
  assert.match(out, /初始体重70/);
  assert.match(out, /最新实测体重77\.75\(2026-07-05\)/);

  // 无实测点时不渲染该字段（只有初始体重）
  const noWeight = compressContext(makePack());
  assert.match(noWeight, /初始体重70/);
  assert.doesNotMatch(noWeight, /最新实测体重/);
});

test("compressContext 无记录时周/月行仍输出（0天，AI 可如实说没数据）", () => {
  const pack = makePack();
  pack.card.week = { avg_deficit: 0, logged_days: 0 };
  pack.card.month = { logged_days: 0, avg_in: 0 };
  const out = compressContext(pack);
  assert.match(out, /【本周】平均缺口0kcal 已记录0天/);
  assert.match(out, /【本月】平均摄入0kcal 已记录0天/);
});

test("compressContext 跨天 recent_turns 渲染相对时间前缀（今天/昨天/M月D日）", () => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const older = new Date(now.getTime() - 5 * 24 * 3600 * 1000);
  const pack = makePack({
    recent_turns: [
      { said: "上周的话", intent: "chat", at: older },
      { said: "昨晚的话", intent: "chat", at: yesterday },
      { said: "今天的话", intent: "chat", at: now },
    ],
  });
  const out = compressContext(pack);
  const lines = out.split("\n");
  const olderLine = lines.find((l) => l.includes("上周的话"))!;
  const yLine = lines.find((l) => l.includes("昨晚的话"))!;
  const todayLine = lines.find((l) => l.includes("今天的话"))!;

  assert.match(olderLine, /^\s*\[\d{1,2}月\d{1,2}日\] 用户:/);
  assert.match(yLine, /^\s*\[昨天\d{2}:\d{2}\] 用户:/);
  assert.match(todayLine, /^\s*\[\d{2}:\d{2}\] 用户:/);
  assert.doesNotMatch(todayLine, /昨天|月/);
});

test("compressContext 无 at 的 turn 不带时间前缀（向后兼容）", () => {
  const pack = makePack({ recent_turns: [{ said: "无时间戳", intent: "chat" }] });
  const out = compressContext(pack);
  const line = out.split("\n").find((l) => l.includes("无时间戳"))!;
  assert.match(line, /^\s*用户:"无时间戳"/);
});

// ═══ T37 双向记忆：TurnSummary.reply 渲染 + 截断护栏 ═══

test("compressContext 渲染 AI 回复摘要（reply 段跟在动作后）", () => {
  const pack = makePack({
    recent_turns: [
      { said: "蛋白质还差多少", intent: "query", reply: "还差 35g，建议来份鸡胸肉" },
      { said: "行，来一份", intent: "record", foods: [{ name: "鸡胸肉", portion: "medium" }] },
    ],
  });
  const out = compressContext(pack);
  assert.match(out, /用户:"蛋白质还差多少" → 查询；AI:"还差 35g，建议来份鸡胸肉"/);
  assert.match(out, /用户:"行，来一份" → 记录\(鸡胸肉\/medium\)/);
});

test("compressContext 渲染 resolve 轮（卡片确认 + 食物锚点）", () => {
  const pack = makePack({
    recent_turns: [
      {
        said: "[点选卡片]", intent: "resolve",
        foods: [{ name: "煎饼果子", portion: "medium" }],
        reply: "确认：煎饼果子 中份 450g",
      },
      { said: "[点选卡片]", intent: "resolve", reply: "已删除：牛肉面" },
    ],
  });
  const out = compressContext(pack);
  assert.match(out, /用户:"\[点选卡片\]" → 卡片确认\(煎饼果子\/medium\)；AI:"确认：煎饼果子 中份 450g"/);
  // 无 foods（删除确认）不渲染空括号
  assert.match(out, /用户:"\[点选卡片\]" → 卡片确认；AI:"已删除：牛肉面"/);
});

test("compressContext 无 reply 的 turn 渲染不带 AI 段（向后兼容旧日志）", () => {
  const pack = makePack({ recent_turns: [{ said: "老日志", intent: "chat" }] });
  const out = compressContext(pack);
  const line = out.split("\n").find((l) => l.includes("老日志"))!;
  assert.doesNotMatch(line, /AI:/);
});

test("compressContext 超长 said/reply 渲染后被截断（said≤60+…，reply≤150+…）", () => {
  const longSaid = "长".repeat(500);
  const longReply = "答".repeat(300);
  const pack = makePack({ recent_turns: [{ said: longSaid, intent: "chat", reply: longReply }] });
  const out = compressContext(pack);
  const line = out.split("\n").find((l) => l.includes("长长长"))!;
  const saidMatch = line.match(/用户:"([^"]*)"/)!;
  const replyMatch = line.match(/AI:"([^"]*)"/)!;
  assert.equal(saidMatch[1], "长".repeat(60) + "…");
  assert.equal(replyMatch[1], "答".repeat(150) + "…");
});

// ═══ T38 pending 感知：【待确认】行 ═══

test("compressContext 无 pending 时不输出【待确认】行", () => {
  const out = compressContext(makePack());
  assert.doesNotMatch(out, /【待确认】/);
});

test("compressContext 渲染份量卡 pending", () => {
  const pack = makePack({
    pending: {
      id: "p1", type: "portion_choice", food_name: "煎饼果子",
      portions: [{ label: "small", grams: 300 }, { label: "medium", grams: 450 }, { label: "large", grams: 600 }],
    },
  });
  const out = compressContext(pack);
  assert.match(out, /【待确认】份量卡：煎饼果子 小\(300g\)\/中\(450g\)\/大\(600g\)，可自定克数/);
});

test("compressContext 渲染候选卡 pending", () => {
  const pack = makePack({
    pending: { id: "p1", type: "food_choice", query: "煎饼", candidate_names: ["煎饼果子", "鸡蛋煎饼", "酱香饼"] },
  });
  const out = compressContext(pack);
  assert.match(out, /【待确认】候选卡："煎饼" → 煎饼果子\/鸡蛋煎饼\/酱香饼/);
});

test("compressContext 5 轮全量 L0 渲染文本 ≤ ~1200 字（上下文预算护栏）", () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({
    said: `第${i}轮`.padEnd(500, "话"),
    intent: "chat",
    reply: "答".repeat(300),
    at: new Date(),
  }));
  const out = compressContext(makePack({ recent_turns: turns }));
  const l0Start = out.indexOf("【最近对话】");
  const l0Block = out.slice(l0Start);
  // 最坏情况每行 ≈ 时间8 + said 61 + reply 151 + 结构字符 ≈ 241，5 行 + 标题 ≈ 1220
  assert.ok(l0Block.length <= 1250, `L0 块 ${l0Block.length} 字超预算`);
});
