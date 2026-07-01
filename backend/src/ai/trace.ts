import { createHash } from "crypto";
import { prisma } from "../lib/prisma";
import type { MemoryPack } from "../services/memory";

// ────────────────────────────────────────────────────────────
// AI Trace — 底层 API
//
// 职责：trace 表的 CRUD + 控制开关 + state envelope 常量。
// 不做业务语义建模（那是 services/trace.ts 的事）。
//
// 三层开关（env，模块加载时解析一次）：
//   L1  AI_TRACE             = enabled | minimal | disabled
//   L2  AI_TRACE_EVENTS      = all | parse,normalize,...（逗号分隔）
//   L3  AI_TRACE_SAMPLE_RATE = 0.0 ~ 1.0
//
// 所有写操作内部 try-catch——trace 失败不影响主流程。
// ────────────────────────────────────────────────────────────

// ── 类型 ──

type TraceLevel = "enabled" | "minimal" | "disabled";

/** 7 种 event，对应一次 AI 调用的完整处理链路 */
export type EventType =
  | "parse"
  | "normalize"
  | "confidence"
  | "decision"
  | "output"
  | "correction"
  | "error";

// ── 配置 ──

const LEVEL: TraceLevel = (
  process.env.AI_TRACE === "enabled"
    ? "enabled"
    : process.env.AI_TRACE === "minimal"
    ? "minimal"
    : "disabled"
);

const ALL_EVENTS: EventType[] = [
  "parse", "normalize", "confidence", "decision", "output", "correction", "error",
];

const EVENTS_RAW = process.env.AI_TRACE_EVENTS || "all";
const ENABLED_EVENTS = new Set<EventType>(
  EVENTS_RAW === "all" ? ALL_EVENTS : EVENTS_RAW.split(",").filter((e) =>
    ALL_EVENTS.includes(e as EventType)
  ) as EventType[],
);

const SAMPLE_RATE = parseFloat(process.env.AI_TRACE_SAMPLE_RATE || "1.0");

// ── 开关 ──

/** 全局 trace 是否开启（disabled 时所有写操作直接返回） */
export function isEnabled(): boolean {
  return LEVEL !== "disabled";
}

/** 采样判定：SAMPLE_RATE=1.0 全记，0.1 随机记 10% */
function shouldSample(): boolean {
  if (SAMPLE_RATE >= 1.0) return true;
  return Math.random() < SAMPLE_RATE;
}

/**
 * 逐 event 判定是否需要记录。
 * 判断顺序：disabled → minimal(仅 parse) → 事件类型白名单 → 采样率。
 */
export function shouldRecordEvent(type: EventType): boolean {
  if (LEVEL === "disabled") return false;
  if (LEVEL === "minimal") return type === "parse";
  if (!ENABLED_EVENTS.has(type)) return false;
  return shouldSample();
}

// ── Prompt 版本指纹 ──

/**
 * 对静态 system prompt 文本取 SHA256 前 8 位 hex。
 * 只 hash 开发者手写的 system prompt，不 hash 动态上下文（compressContext / user message）。
 * 用途：按 prompt 版本分组对比各项指标。
 */
export function hashPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

// ── State envelope ──
//
// state_before / state_after 的统一 key 集合（16 个）。
// 每种 event 只填自己涉及的 key，其余留 null。
// 同一组 key 使得跨 event type 的 diff 查询成为可能——
// 不需要知道 event_type，不需要分支逻辑。

const ENVELOPE_KEYS = [
  "canonical",               // AI 归一后的食物名
  "matched_food_id",         // 数据库匹配到的 food_standard.id
  "matched_food_name",       // 数据库匹配到的食物名
  "match_path",              // 匹配管线路径：exact_name | alias | prefix_true_spec | ...
  "food_confidence",         // DeepSeek 给出的食物识别置信度 0-1
  "portion_confidence",      // DeepSeek 给出的份量置信度 0-1
  "is_ambiguous",            // AI 语义判定食物是否歧义
  "calorie_spread",          // DB 候选食物的热量离散度（kcal/100g）
  "confidence_verdict",      // 置信评估结论：confident | ambiguous | portion_uncertain | food_low
  "routing_action",          // 路由结果：auto_commit | candidate_card | portion_card | clarify_card
  "threshold_food_high",     // 食物高置信阈值（当前 0.8）
  "threshold_portion_high",  // 份量高置信阈值（当前 0.8）
  "record_id",               // 产出的 food_record.id
  "pending_id",              // 产出的 pending_record.id
  "entity_type",             // 实体类型（"food_standard"）
  "entity_id",               // 实体 ID（food_standard.id），用于跨 trace 聚类
] as const;

/** 创建一个所有 key 为 null 的 state envelope */
export function createEmptyState(): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const k of ENVELOPE_KEYS) state[k] = null;
  return state;
}

/** 从 source 中只摘取 ENVELOPE_KEYS 包含的 key，其余丢弃 */
function pickEnvelope(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENVELOPE_KEYS) {
    if (k in source) out[k] = source[k];
  }
  return out;
}

// ── State snapshot ──

/**
 * 从 MemoryPack 构建 trace 级别的结构化上下文快照。
 * 回放一条 trace 时，不需要跨 daily_summary / food_record / users 三张表
 * 去还原"当时的状态"——trace 自包含。
 */
export function buildStateSnapshot(pack: MemoryPack, mealType: string): object {
  const todayCard = pack.card.today;
  const mealItems = pack.recent_records
    .filter((r) => r.kind === "food" && r.meal_type === mealType)
    .map((r) => ({
      ref: r.ref,
      name: r.name,
      weight_g: r.weight_g,
      calories: r.calories,
    }));

  return {
    meal_context: {
      meal_type: mealType,
      existing_items: mealItems,
      existing_calories: mealItems.reduce((s, it) => s + it.calories, 0),
    },
    daily_context: {
      calories_in_so_far: todayCard.in,
      remaining: todayCard.remaining,
      protein_so_far: todayCard.p,
      target_protein: pack.card.targets.protein,
      target_calories: pack.card.targets.calories,
    },
    profile_snapshot: {
      weight_kg: pack.profile.weight_kg,
      target_weight_kg: pack.profile.target_weight_kg,
      goal_type: pack.profile.goal_type,
      daily_deficit: pack.profile.daily_deficit,
    },
  };
}

// ── Trace 生命周期 ──

interface CreateTraceParams {
  userId: string;
  sessionId?: string;
  mealId?: string;
  inputText: string;
  stateSnapshot?: object;
}

/**
 * 创建一条 trace（status="started"），返回 traceId。
 * disabled 时返回空字符串，后续所有操作判空跳过。
 */
export async function createTrace(params: CreateTraceParams): Promise<string> {
  if (!isEnabled()) return "";

  try {
    const trace = await prisma.aiTrace.create({
      data: {
        user_id: params.userId,
        session_id: params.sessionId ?? null,
        meal_id: params.mealId ?? null,
        input_text: params.inputText,
        status: "started",
        state_snapshot: (params.stateSnapshot as object) ?? undefined,
      },
    });
    return trace.id;
  } catch {
    return "";
  }
}

interface FinalizeTraceParams {
  intent?: string;
  status: string;
  modelUsed?: string;
  modelUpgraded?: boolean;
  latencyMs?: number;
  tokenUsage?: object;
  errorInfo?: object;
  promptMessages?: object;
  promptTools?: object;
  promptHash?: string;
  mealId?: string;
}

/**
 * 结束一条 trace——写入 intent / status / model / latency / prompt 快照等聚合字段。
 * traceId 为空时直接返回（disabled 或创建失败）。
 */
export async function finalizeTrace(
  traceId: string,
  params: FinalizeTraceParams,
): Promise<void> {
  if (!traceId) return;

  try {
    await prisma.aiTrace.update({
      where: { id: traceId },
      data: {
        intent: params.intent,
        status: params.status,
        model_used: params.modelUsed,
        model_upgraded: params.modelUpgraded ?? false,
        latency_ms: params.latencyMs,
        token_usage: (params.tokenUsage as object) ?? undefined,
        error_info: (params.errorInfo as object) ?? undefined,
        prompt_messages: (params.promptMessages as object) ?? undefined,
        prompt_tools: (params.promptTools as object) ?? undefined,
        prompt_hash: params.promptHash,
        meal_id: params.mealId,
      },
    });
  } catch {
    // trace 更新失败不影响主流程
  }
}

// ── Event 写入 ──

interface RecordEventParams {
  traceId: string;
  itemIndex?: number;
  seq: number;
  eventType: EventType;
  stateBefore: Record<string, unknown>;
  stateAfter: Record<string, unknown>;
  inputState?: Record<string, unknown>;
  outputState?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/**
 * 写入单条 trace event。
 * - stateBefore / stateAfter 自动过滤到 ENVELOPE_KEYS
 * - inputState / outputState 原样存储（event 特有 detail）
 * - 写入失败静默吞掉，不影响主流程
 */
export async function recordEvent(params: RecordEventParams): Promise<void> {
  if (!params.traceId) return;
  if (!shouldRecordEvent(params.eventType)) return;

  try {
    await prisma.aiTraceEvent.create({
      data: {
        trace_id: params.traceId,
        item_index: params.itemIndex ?? null,
        seq: params.seq,
        event_type: params.eventType,
        state_before: pickEnvelope(params.stateBefore) as object,
        state_after: pickEnvelope(params.stateAfter) as object,
        input_state: (params.inputState as object) ?? undefined,
        output_state: (params.outputState as object) ?? undefined,
        meta: (params.meta as object) ?? undefined,
      },
    });
  } catch {
    // trace 写入失败不影响主流程
  }
}

// ── 批量写入（暂未使用，预留） ──

export interface EventBatchItem {
  itemIndex?: number;
  seq: number;
  eventType: EventType;
  stateBefore: Record<string, unknown>;
  stateAfter: Record<string, unknown>;
  inputState?: Record<string, unknown>;
  outputState?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** 批量写入多条 event（单次 createMany），受开关和采样率控制 */
export async function recordEvents(
  traceId: string,
  events: EventBatchItem[],
): Promise<void> {
  if (!traceId || events.length === 0) return;

  const toWrite = events.filter((e) => shouldRecordEvent(e.eventType));
  if (toWrite.length === 0) return;

  const rows = toWrite.map((e) => ({
    trace_id: traceId,
    item_index: e.itemIndex ?? null,
    seq: e.seq,
    event_type: e.eventType,
    state_before: pickEnvelope(e.stateBefore) as object,
    state_after: pickEnvelope(e.stateAfter) as object,
    input_state: (e.inputState as object) ?? undefined,
    output_state: (e.outputState as object) ?? undefined,
    meta: (e.meta as object) ?? undefined,
  }));

  await prisma.aiTraceEvent.createMany({ data: rows });
}
