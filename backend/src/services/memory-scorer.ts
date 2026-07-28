// Scoring Engine — 语义记忆评分引擎（MEMORY_SPEC §5）
// 纯函数，零副作用，可直接单测。
//
// score = clamp(llm_confidence × type_weight × importance × rep_boost × decay, 0, 1)
// 乘法融合：任一因子归零则整体归零（与 LEARNING_SPEC 贝叶斯精神一致）

export type MemoryType = "constraint" | "preference" | "habit" | "context_state" | "goal";
export type ImportanceClass = "medical" | "strong" | "normal" | "casual";
export type MemoryState = "ACTIVE" | "WEAK" | "ARCHIVED";

// ── 类型权重（MEMORY_SPEC §5.2）──
const TYPE_WEIGHT: Record<MemoryType, number> = {
  constraint: 1.0,     // 用户不会拿过敏/疾病开玩笑
  preference: 0.90,    // 明确偏好通常真实，但可能有夸张
  context_state: 0.88, // 临时状态通常被动描述，较真实
  habit: 0.85,         // "通常"、"一般"不保证每次都如此
  goal: 0.80,          // 目标最容易随口一说然后放弃
};

// ── 衰减速率 λ（MEMORY_SPEC §3）──
const LAMBDA: Record<MemoryType, number> = {
  constraint: 0,       // 不衰减（过敏不会自愈）
  preference: 0.001,   // ~3 年衰减到 ~0.3
  habit: 0.002,        // ~1.5 年衰减到 ~0.33
  context_state: 0.015,// ~2 周到 WEAK、~3 周到 ARCHIVED（T75 从季级重标到周级）
  goal: 0.02,          // ~1 月衰减到 ~0.55
};

// ── 双阈值滞回（MEMORY_SPEC §8.1）──
const ACTIVE_UP: Record<MemoryType, number> = {
  constraint: 0.48,
  preference: 0.55,
  context_state: 0.55,
  habit: 0.58,
  goal: 0.65,
};

const ACTIVE_DOWN: Record<MemoryType, number> = {
  constraint: 0.40,
  preference: 0.45,
  context_state: 0.45,
  habit: 0.48,
  goal: 0.55,
};

// ── Importance 映射（MEMORY_SPEC §5.2）──
// LLM 输出离散 class → 系统确定性映射，避免 LLM 连续值方差破坏评分引擎
export function importanceMap(cls: ImportanceClass): number {
  const map: Record<ImportanceClass, number> = {
    medical: 1.3,   // 安全/医疗级
    strong: 1.1,    // 重要偏好或强习惯
    normal: 1.0,    // 普通
    casual: 0.85,   // 随口提及
  };
  return map[cls] ?? 1.0;
}

// ── 重复强化（MEMORY_SPEC §5.2）──
// rep_boost(n) = 1 - exp(-1.2 × n)
// n=1→0.70, n=2→0.91, n=3→0.97, n=4+→~1.0
export function repetitionBoost(n: number): number {
  if (n < 0) n = 0;
  return 1 - Math.exp(-1.2 * n);
}

// ── 时间衰减（MEMORY_SPEC §5.2）──
// decay = exp(-λ(type) × days_since_last_access)
// Δt 基准：last_accessed_at = 上次**被用户提及或更新**的时间，非 created_at。
// 系统检索注入**不**刷新它（T75）——否则被反复注入的陈旧记忆 decay 永远重置回 1.0，
// 越是影响对话的越不会消失。见 MEMORY_SPEC §5.2。
export function decay(type: MemoryType, daysSinceLastAccess: number): number {
  if (daysSinceLastAccess < 0) daysSinceLastAccess = 0;
  return Math.exp(-LAMBDA[type] * daysSinceLastAccess);
}

// ── 综合评分（MEMORY_SPEC §5.1）──
export interface ScoreParams {
  llm_confidence: number;
  type: MemoryType;
  importance_class: ImportanceClass;
  repetition_count: number;
  days_since_last_access: number;
  /** expires_at 已过。任何类型都适用（T75，原先硬编码只认 goal） */
  expired?: boolean;
}

export function computeScore(params: ScoreParams): number {
  const tw = TYPE_WEIGHT[params.type];
  const imp = importanceMap(params.importance_class);
  const rep = repetitionBoost(params.repetition_count);
  const dk = decay(params.type, params.days_since_last_access);

  let score = params.llm_confidence * tw * imp * rep * dk;

  // 过期后额外 × 0.2 惩罚（MEMORY_SPEC §5.4 场景7）。
  // 检索层已经直接把过期记忆挡在外面（loadActiveMemories），这里的惩罚负责让
  // 凌晨的 recalcAndPrune 把 state 落库对齐——两者是同一件事的即时面和持久面。
  if (params.expired) {
    score *= 0.2;
  }

  return clamp(score, 0, 1);
}

// ── 状态判定（MEMORY_SPEC §8.1）──
// 双阈值滞回：晋升阈值 ≠ 降级阈值，死区 0.05-0.10 防止 WEAK↔ACTIVE 震荡
export function decideState(
  type: MemoryType,
  score: number,
  currentState: MemoryState,
): MemoryState {
  // 统一 ARCHIVED 底线：所有类型 score < 0.40 → ARCHIVED
  if (score < 0.40) return "ARCHIVED";

  const up = ACTIVE_UP[type];
  const down = ACTIVE_DOWN[type];

  if (currentState === "ACTIVE") {
    // 降级：score < ACTIVE_DOWN → WEAK
    if (score < down) return "WEAK";
    return "ACTIVE"; // 死区内保持 ACTIVE
  }

  // WEAK 或 ARCHIVED 状态
  if (score >= up) return "ACTIVE"; // 晋升

  // ARCHIVED 复活的特殊处理：不自动从 ARCHIVED 升到 WEAK
  // 只在 rep_boost 增加后 score 越过 ACTIVE_UP 才升 ACTIVE
  if (currentState === "ARCHIVED") return "ARCHIVED";

  // WEAK + 死区 → 保持 WEAK
  return "WEAK";
}

/**
 * 带医疗地板的状态判定（T74 口径 3）。
 *
 * `importance_class = 'medical'`（过敏/诊断）的记忆，**任何自动机制都只能降到 WEAK**——
 * 作废/降权、每日 recalc cron 都不许把它判成 ARCHIVED。误删一条"花生过敏"和误删一条
 * "最近出差"差着几个数量级，ARCHIVED 只能由用户在记忆中心手动做。
 *
 * 所有会写 state 的自动路径都必须走这个函数，不要直接用 decideState。
 */
export function decideStateWithFloor(
  type: MemoryType,
  importanceClass: ImportanceClass,
  score: number,
  currentState: MemoryState,
): MemoryState {
  const next = decideState(type, score, currentState);
  if (importanceClass === "medical" && next === "ARCHIVED") return "WEAK";
  return next;
}

// ── 工具函数 ──
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}
