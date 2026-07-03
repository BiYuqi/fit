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
    ...over,
  };
}

test("compressContext 输出【本周】【本月】行（数据取自 card.week / card.month）", () => {
  const out = compressContext(makePack());
  assert.match(out, /【本周】平均缺口450kcal 已记录6天/);
  assert.match(out, /【本月】平均摄入1400kcal 已记录23天/);
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
