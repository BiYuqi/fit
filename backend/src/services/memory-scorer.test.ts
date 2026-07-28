// Scoring Engine 单测（MEMORY_SPEC §5.4 8 个场景 + 边界情况）

import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import {
  computeScore,
  decideState,
  decideStateWithFloor,
  importanceMap,
  repetitionBoost,
  decay,
  clamp,
  daysBetween,
  type MemoryType,
  type ImportanceClass,
} from "./memory-scorer";

// 容差
function approx(actual: number, expected: number, msg?: string) {
  const diff = Math.abs(actual - expected);
  assert.ok(diff < 0.015, `${msg ?? ""} expected ≈${expected}, got ${actual} (diff=${diff.toFixed(4)})`);
}

// ── 单元函数 ──

describe("importanceMap", () => {
  test("medical → 1.3", () => {
    assert.equal(importanceMap("medical"), 1.3);
  });
  test("strong → 1.1", () => {
    assert.equal(importanceMap("strong"), 1.1);
  });
  test("normal → 1.0", () => {
    assert.equal(importanceMap("normal"), 1.0);
  });
  test("casual → 0.85", () => {
    assert.equal(importanceMap("casual"), 0.85);
  });
});

describe("repetitionBoost", () => {
  test("n=1 → 0.70", () => {
    approx(repetitionBoost(1), 0.70);
  });
  test("n=2 → 0.91", () => {
    approx(repetitionBoost(2), 0.91);
  });
  test("n=3 → 0.97", () => {
    approx(repetitionBoost(3), 0.97);
  });
  test("n=4 → ~0.99", () => {
    approx(repetitionBoost(4), 0.99);
  });
  test("n=0 → 0", () => {
    assert.equal(repetitionBoost(0), 0);
  });
  test("n<0 clamps to 0", () => {
    assert.equal(repetitionBoost(-5), 0);
  });
});

describe("decay", () => {
  test("constraint λ=0, no decay ever", () => {
    assert.equal(decay("constraint", 0), 1.0);
    assert.equal(decay("constraint", 365), 1.0);
  });
  test("preference λ=0.001, 1 year", () => {
    approx(decay("preference", 365), Math.exp(-0.001 * 365)); // ~0.694
  });
  test("habit λ=0.002, 2 months", () => {
    approx(decay("habit", 60), 0.887);
  });
  test("context_state λ=0.015, 30 days", () => {
    approx(decay("context_state", 30), 0.638);
  });
  // T75 的核心标定：首次 context_state（score 0.5544）必须在 ~14 天掉出 ACTIVE
  test("context_state 首次 14 天后跌破 ACTIVE_DOWN", () => {
    const base = 0.90 * 0.88 * 1.0 * 0.70; // conf × type_weight × importance × rep_boost(1)
    assert.ok(base * decay("context_state", 13) > 0.45, "13 天时还该在线上");
    assert.ok(base * decay("context_state", 15) < 0.45, "15 天时该跌破 ACTIVE_DOWN");
  });
  test("goal λ=0.02, 180 days", () => {
    approx(decay("goal", 180), 0.027);
  });
  test("negative days clamps to 0", () => {
    assert.equal(decay("preference", -10), 1.0);
  });
});

describe("clamp", () => {
  test("within range", () => assert.equal(clamp(0.5, 0, 1), 0.5));
  test("below min", () => assert.equal(clamp(-0.1, 0, 1), 0));
  test("above max", () => assert.equal(clamp(1.5, 0, 1), 1));
});

describe("daysBetween", () => {
  test("same day = 0", () => {
    const d = new Date("2026-07-07T12:00:00Z");
    assert.equal(daysBetween(d, d), 0);
  });
  test("one day apart", () => {
    approx(daysBetween(new Date("2026-07-08T00:00:00Z"), new Date("2026-07-07T00:00:00Z")), 1.0);
  });
});

// ── MEMORY_SPEC §5.4 八个场景 ──

describe("MEMORY_SPEC §5.4 场景演算", () => {
  // 场景 1：花生过敏首次（constraint + medical → score 0.86 → ACTIVE）
  test("场景1: 花生过敏首次 → ACTIVE (0.86)", () => {
    const score = computeScore({
      llm_confidence: 0.95,
      type: "constraint",
      importance_class: "medical",
      repetition_count: 1,
      days_since_last_access: 0,
    });
    approx(score, 0.86);
    assert.equal(decideState("constraint", score, "WEAK"), "ACTIVE");
  });

  // 场景 2：爱吃辣首次（preference + normal → score 0.54）
  //   score 0.54 < ACTIVE_UP[preference]=0.55（§8.1 滞回），初始 WEAK 维持 WEAK
  test("场景2: 爱吃辣首次 → WEAK (score=0.54, < ACTIVE_UP 0.55)", () => {
    const score = computeScore({
      llm_confidence: 0.85,
      type: "preference",
      importance_class: "normal",
      repetition_count: 1,
      days_since_last_access: 0,
    });
    approx(score, 0.54);
    // 0.54 < ACTIVE_UP[preference]=0.55，不晋升
    assert.equal(decideState("preference", score, "WEAK"), "WEAK");
  });

  // 场景 3：不吃香菜第 3 次 + 2 月（preference + normal + decay → score 0.74 → ACTIVE）
  test("场景3: 不吃香菜第三次+2月 → ACTIVE (0.74)", () => {
    const score = computeScore({
      llm_confidence: 0.90,
      type: "preference",
      importance_class: "normal",
      repetition_count: 3,
      days_since_last_access: 60,
    });
    approx(score, 0.74);
    assert.equal(decideState("preference", score, "ACTIVE"), "ACTIVE");
  });

  // 场景 4：出差状态首次（context_state + normal → score 0.52）
  //   score 0.52 < ACTIVE_UP[context_state]=0.55，初始 WEAK 维持 WEAK
  test("场景4: 出差首次 → WEAK (score=0.52, < ACTIVE_UP 0.55)", () => {
    const score = computeScore({
      llm_confidence: 0.85,
      type: "context_state",
      importance_class: "normal",
      repetition_count: 1,
      days_since_last_access: 0,
    });
    approx(score, 0.52);
    // 0.52 < ACTIVE_UP[context_state]=0.55，不晋升
    assert.equal(decideState("context_state", score, "WEAK"), "WEAK");
  });

  // 场景 5：不吃早饭首次 + 2 月未提（habit + normal + decay → score 0.449 → WEAK）
  test("场景5: 不吃早饭+2月 → WEAK (0.449)", () => {
    const score = computeScore({
      llm_confidence: 0.85,
      type: "habit",
      importance_class: "normal",
      repetition_count: 1,
      days_since_last_access: 60,
    });
    approx(score, 0.449);
    // 0.449 < ACTIVE_UP[habit]=0.58, >= 0.40 → stays WEAK
    assert.equal(decideState("habit", score, "WEAK"), "WEAK");
    // If it were ACTIVE, it would drop to WEAK (0.449 < ACTIVE_DOWN[habit]=0.48)
    assert.equal(decideState("habit", score, "ACTIVE"), "WEAK");
  });

  // 场景 6：备赛半年前（goal + normal + decay → score 0.012 → ARCHIVED）
  test("场景6: 备赛半年前 → ARCHIVED (0.012)", () => {
    const score = computeScore({
      llm_confidence: 0.80,
      type: "goal",
      importance_class: "normal",
      repetition_count: 1,
      days_since_last_access: 180,
    });
    approx(score, 0.012);
    assert.equal(decideState("goal", score, "WEAK"), "ARCHIVED");
    assert.equal(decideState("goal", score, "ACTIVE"), "ARCHIVED");
  });

  // 场景 7：控碳水 2 周过期（goal + normal + expires_at → score 0.068 → ARCHIVED）
  test("场景7: 控碳水过期 → ARCHIVED (0.068)", () => {
    const score = computeScore({
      llm_confidence: 0.80,
      type: "goal",
      importance_class: "normal",
      repetition_count: 1,
      days_since_last_access: 14,
      expired: true,
    });
    approx(score, 0.068);
    assert.equal(decideState("goal", score, "WEAK"), "ARCHIVED");
  });

  // 场景 8：胃不舒服首次（preference + strong → score 0.589 → ACTIVE）
  test("场景8: 胃不舒服首次 → ACTIVE (0.589)", () => {
    const score = computeScore({
      llm_confidence: 0.85,
      type: "preference",
      importance_class: "strong",
      repetition_count: 1,
      days_since_last_access: 0,
    });
    approx(score, 0.589);
    assert.equal(decideState("preference", score, "WEAK"), "ACTIVE");
  });
});

// ── decideState 边界 ──

describe("decideState 滞回行为", () => {
  test("constraint: score 0.47 在死区，保持当前状态", () => {
    // ACTIVE_DOWN[constraint]=0.40, ACTIVE_UP=0.48
    // 0.47 >= 0.40 且 < 0.48, 正在死区
    assert.equal(decideState("constraint", 0.47, "ACTIVE"), "ACTIVE"); // 死区内不下调
    assert.equal(decideState("constraint", 0.47, "WEAK"), "WEAK");     // 死区内不上调
  });

  test("preference: ACTIVE_UP=0.55, ACTIVE_DOWN=0.45", () => {
    // 晋升
    assert.equal(decideState("preference", 0.56, "WEAK"), "ACTIVE");
    // 死区
    assert.equal(decideState("preference", 0.50, "WEAK"), "WEAK");
    assert.equal(decideState("preference", 0.50, "ACTIVE"), "ACTIVE");
    // 降级
    assert.equal(decideState("preference", 0.44, "ACTIVE"), "WEAK");
  });

  test("ARCHIVED 不自动复活到 WEAK，需越过 ACTIVE_UP 直接到 ACTIVE", () => {
    const score = computeScore({
      llm_confidence: 0.90,
      type: "preference",
      importance_class: "strong",
      repetition_count: 3,
      days_since_last_access: 0,
    });
    // score ~1.07, clamped to 1.0, well above ACTIVE_UP
    assert.equal(decideState("preference", clamp(score, 0, 1), "ARCHIVED"), "ACTIVE");

    // score 0.50 在 dead zone, shouldn't revive from ARCHIVED
    assert.equal(decideState("preference", 0.52, "ARCHIVED"), "ARCHIVED");
  });

  test("ARCHIVED 底线 0.40 对全类型统一", () => {
    for (const type of ["constraint", "preference", "habit", "context_state", "goal"] as MemoryType[]) {
      assert.equal(decideState(type, 0.39, "ACTIVE"), "ARCHIVED");
      assert.equal(decideState(type, 0.39, "WEAK"), "ARCHIVED");
    }
  });

  test("score 0.40 恰好不触发 ARCHIVED（但可能触发降级）", () => {
    // 0.40 恰好不下穿 ARCHIVED 底线（< 0.40 才 ARCHIVED）
    assert.equal(decideState("preference", 0.40, "WEAK"), "WEAK");
    // 但 preference ACTIVE_DOWN=0.45，所以 ACTIVE 状态会被降级到 WEAK
    assert.equal(decideState("preference", 0.40, "ACTIVE"), "WEAK");
  });
});

// ── computeScore 边界 ──

describe("computeScore 边界", () => {
  test("任一因子为 0 则 score 为 0（乘法融合）", () => {
    assert.equal(
      computeScore({
        llm_confidence: 0,
        type: "constraint",
        importance_class: "medical",
        repetition_count: 3,
        days_since_last_access: 0,
      }),
      0
    );
    assert.equal(
      computeScore({
        llm_confidence: 0.95,
        type: "constraint",
        importance_class: "medical",
        repetition_count: 0,
        days_since_last_access: 0,
      }),
      0
    );
  });

  // T75：过期惩罚放开到全类型（原先硬编码只认 goal，等于给 context_state 设过期时间没用）
  test("expired 对 context_state 同样生效", () => {
    const params = {
      llm_confidence: 0.90,
      type: "context_state" as const,
      importance_class: "normal" as const,
      repetition_count: 1,
      days_since_last_access: 0,
    };
    approx(computeScore(params), 0.5544);
    approx(computeScore({ ...params, expired: true }), 0.5544 * 0.2);
  });

  test("极度衰减导致 score → 0", () => {
    const score = computeScore({
      llm_confidence: 0.90,
      type: "goal",
      importance_class: "normal",
      repetition_count: 1,
      days_since_last_access: 1000,
    });
    assert.ok(score < 0.01, `expected near 0, got ${score}`);
  });

  test("所有因子最强 → score clamped to 1.0", () => {
    const score = computeScore({
      llm_confidence: 0.99,
      type: "constraint",
      importance_class: "medical",
      repetition_count: 10,
      days_since_last_access: 0,
    });
    assert.equal(score, 1.0);
  });
});

describe("T74: 医疗地板——自动机制不许把 medical 判成 ARCHIVED", () => {
  test("medical + score 低于 ARCHIVED 线 → 兜到 WEAK", () => {
    // 0.2375（被否认折半两次的置信度）× 1.0 × 1.3 × 0.70 = 0.216，远低于 0.40
    const score = computeScore({
      llm_confidence: 0.2375,
      type: "constraint",
      importance_class: "medical",
      repetition_count: 1,
      days_since_last_access: 0,
    });
    assert.equal(decideState("constraint", score, "ACTIVE"), "ARCHIVED");
    assert.equal(decideStateWithFloor("constraint", "medical", score, "ACTIVE"), "WEAK");
  });

  test("非 medical 不受地板保护，照常 ARCHIVED", () => {
    assert.equal(decideStateWithFloor("context_state", "normal", 0.2, "ACTIVE"), "ARCHIVED");
    assert.equal(decideStateWithFloor("constraint", "strong", 0.2, "ACTIVE"), "ARCHIVED");
  });

  test("地板只堵 ARCHIVED，不干预 ACTIVE/WEAK 的正常判定", () => {
    assert.equal(decideStateWithFloor("constraint", "medical", 0.9, "WEAK"), "ACTIVE");
    assert.equal(decideStateWithFloor("constraint", "medical", 0.42, "ACTIVE"), "ACTIVE");
    assert.equal(decideStateWithFloor("constraint", "medical", 0.42, "WEAK"), "WEAK");
  });
});
