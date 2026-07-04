import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveDuration, resolveExerciseCalories } from "./exercise";

// ── resolveDuration ───────────────────────────────────────
// 持续型运动用 duration_min，次数型用 reps 估算，
// 都没有兜底 30min。不依赖 DB/AI，纯函数。

test("有 duration_min → 直接返回", () => {
  assert.equal(resolveDuration({ duration_min: 38 }), 38);
});

test("有 duration_min 也有 reps → duration_min 优先", () => {
  assert.equal(resolveDuration({ duration_min: 38, reps: 65 }), 38);
});

test("仅 reps → 按 4s/次 估算（reps/15，至少 1min）", () => {
  assert.equal(resolveDuration({ reps: 65 }), 4);   // 65/15 ≈ 4.3 → 4
  assert.equal(resolveDuration({ reps: 15 }), 1);   // 15/15 = 1
  assert.equal(resolveDuration({ reps: 10 }), 1);   // 10/15 ≈ 0.67 → max(1,1) = 1
  assert.equal(resolveDuration({ reps: 1 }), 1);    // 边界：1 次也至少 1min
});

test("两个都没有 → 兜底 30min", () => {
  assert.equal(resolveDuration({}), 30);
});

// ── resolveExerciseCalories（T50 用户自报采信 vs MET 兜底）──
test("用户自报 calories_burned → 直接采信，标 user_reported", () => {
  const r = resolveExerciseCalories({ type: "羽毛球", duration_min: 65, calories_burned: 590 }, 65, 70);
  assert.equal(r.calories_burned, 590);
  assert.equal(r.user_reported, true);
});

test("用户自报小数 → 四舍五入采信", () => {
  const r = resolveExerciseCalories({ type: "跑步", duration_min: 30, calories_burned: 312.6 }, 30, 70);
  assert.equal(r.calories_burned, 313);
  assert.equal(r.user_reported, true);
});

test("无自报值 → 回落 MET 估算，标 not user_reported", () => {
  const r = resolveExerciseCalories({ type: "羽毛球", duration_min: 65 }, 65, 70);
  // 羽毛球 MET=5：5 * 70 * (65/60) ≈ 379
  assert.equal(r.calories_burned, 379);
  assert.equal(r.user_reported, false);
});

test("边界：calories_burned=0 走采信路径（0 != null），但 zod positive 上游已拦截不会到这里", () => {
  const r = resolveExerciseCalories({ type: "跑步", duration_min: 30, calories_burned: 0 }, 30, 70);
  assert.equal(r.user_reported, true);
  assert.equal(r.calories_burned, 0);
});
