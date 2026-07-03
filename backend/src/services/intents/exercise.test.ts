import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveDuration } from "./exercise";

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
