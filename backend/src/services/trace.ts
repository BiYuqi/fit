// ────────────────────────────────────────────────────────────
// Trace 服务层 — 业务级的 trace 封装
//
// 为 chat.ts 提供三个层级的抽象：
//
//   ChatTrace   — 一次 POST /chat/message 的 trace 生命周期
//                  begin → recordParse → [setMeal] → ok/fail/partial
//
//   ItemTrace   — 单条 food item 的 normalize→confidence→decision→output 链
//                  getState / setState → normalize / confidence / decision / output
//
//   独立函数     — pending resolve / modify update 的 correction event
//                  recordModifyCorrection / recordDeleteCorrection / recordResolveCorrection
//
// chat.ts 不再直接调 ai/trace.ts 的底层 API。
// ────────────────────────────────────────────────────────────

import { prisma } from "../lib/prisma";
import {
  createTrace,
  finalizeTrace,
  recordEvent,
  createEmptyState,
  buildStateSnapshot,
  hashPrompt,
} from "../ai/trace";
import type { EventType } from "../ai/trace";
import type { MemoryPack } from "./memory";

// ═══════════════════════════════════════════════
// ChatTrace — handler 级 trace 上下文
// ═══════════════════════════════════════════════

export class ChatTrace {
  readonly traceId: string;
  private userId: string;
  private inputText: string;
  private pack: MemoryPack;
  private tStart: number;
  private modelUsed: string = "deepseek-v4-flash";
  private upgraded: boolean = false;
  private promptHash: string;

  private constructor(
    traceId: string,
    userId: string,
    inputText: string,
    pack: MemoryPack,
    promptHash: string,
  ) {
    this.traceId = traceId;
    this.userId = userId;
    this.inputText = inputText;
    this.pack = pack;
    this.tStart = Date.now();
    this.promptHash = promptHash;
  }

  /**
   * 创建一条 trace 并返回 ChatTrace 实例。
   * disabled 时 traceId 为空字符串，所有后续操作静默跳过。
   *
   * @param userId      当前用户 ID
   * @param inputText   用户原始输入文本
   * @param pack        本条消息之前的 MemoryPack（构建 state_snapshot 用）
   * @param opts        sessionId（前端传入，可选）/ promptText（system prompt 原文，算 hash 用）
   */
  static async begin(
    userId: string,
    inputText: string,
    pack: MemoryPack,
    opts?: { sessionId?: string; promptText?: string },
  ): Promise<ChatTrace> {
    const traceId = await createTrace({
      userId,
      sessionId: opts?.sessionId,
      inputText,
    });
    const hash = hashPrompt(opts?.promptText ?? "");
    return new ChatTrace(traceId, userId, inputText, pack, hash);
  }

  /**
   * 记录 parse event。
   * 在 parseUserInput() 返回后、ai_parse_log 写入后调用。
   */
  async recordParse(
    parsed: {
      intent: string;
      items?: Array<{
        canonical?: string;
        food_confidence?: number;
        portion_confidence?: number;
        is_ambiguous?: boolean;
      }>;
    },
    model: string,
    upgraded: boolean,
  ): Promise<void> {
    this.modelUsed = model;
    this.upgraded = upgraded;

    // 取第一个 item 的字段填入 state envelope（parse 是 trace 级事件，取首 item 为代表）
    const sb = createEmptyState();
    if (parsed.intent === "record" && parsed.items && parsed.items.length > 0) {
      const i0 = parsed.items[0];
      sb.canonical = i0.canonical ?? null;
      sb.food_confidence = i0.food_confidence ?? null;
      sb.portion_confidence = i0.portion_confidence ?? null;
      sb.is_ambiguous = i0.is_ambiguous ?? null;
    }

    await recordEvent({
      traceId: this.traceId,
      seq: 0,
      eventType: "parse",
      stateBefore: createEmptyState(),
      stateAfter: sb,
      inputState: { text: this.inputText, model },
      outputState: parsed as Record<string, unknown>,
      meta: {
        duration_ms: Date.now() - this.tStart,
        model_upgraded_to_pro: upgraded,
      },
    });
  }

  /**
   * 写入 meal_id 和 state_snapshot。
   * 在 record 意图确定 meal_type 后调用。
   */
  async setMeal(mealType: string): Promise<void> {
    if (!this.traceId) return;
    const mealId = `${new Date().toISOString().slice(0, 10)}_${mealType}`;
    const snap = buildStateSnapshot(this.pack, mealType);
    try {
      await prisma.aiTrace.update({
        where: { id: this.traceId },
        data: { meal_id: mealId, state_snapshot: snap as object },
      });
    } catch {
      // trace 更新失败不影响主流程
    }
  }

  /** 为第 idx 个 food item 创建 ItemTrace */
  itemTrace(idx: number): ItemTrace {
    return new ItemTrace(this.traceId, idx);
  }

  /** 正常结束 trace，写入 intent + status="ok" + 聚合字段 */
  ok(intent: string, extra?: { mealType?: string }): void {
    const lat = Date.now() - this.tStart;
    finalizeTrace(this.traceId, {
      intent,
      status: "ok",
      modelUsed: this.modelUsed,
      modelUpgraded: this.upgraded,
      latencyMs: lat,
      promptHash: this.promptHash,
      promptMessages: [{ user: this.inputText }] as object,
      mealId: extra?.mealType
        ? `${new Date().toISOString().slice(0, 10)}_${extra.mealType}`
        : undefined,
    });
  }

  /** 异常结束 trace */
  fail(intent: string, errorInfo?: object): void {
    finalizeTrace(this.traceId, {
      intent,
      status: "failed",
      modelUsed: this.modelUsed,
      modelUpgraded: this.upgraded,
      latencyMs: Date.now() - this.tStart,
      errorInfo,
      promptHash: this.promptHash,
      promptMessages: [{ user: this.inputText }] as object,
    });
  }

  /** 部分成功（如 modify 找不到 target） */
  partial(intent: string): void {
    finalizeTrace(this.traceId, {
      intent,
      status: "partial",
      modelUsed: this.modelUsed,
      modelUpgraded: this.upgraded,
      latencyMs: Date.now() - this.tStart,
      promptHash: this.promptHash,
      promptMessages: [{ user: this.inputText }] as object,
    });
  }
}

// ═══════════════════════════════════════════════
// ItemTrace — 单条 food item 的 event 链
// ═══════════════════════════════════════════════

/**
 * 管理一条 food item 的 normalize → confidence → decision → output 事件链。
 *
 * 内部维护 state（当前 envelope 快照）和 seq（事件序号），
 * 每一步自动将当前 state 作为 state_before，更新后作为 state_after。
 *
 * 用法：
 *   const it = tctx.itemTrace(0);
 *   it.setState("canonical", "煎饼");
 *   // ... matchFood ...
 *   await it.normalize(stateAfter, inputState, outputState);
 *   await it.confidence(stateAfter, inputState, outputState, meta);
 *   await it.decision(stateAfter, inputState, outputState, meta);
 *   await it.output(stateAfter, inputState, outputState);
 */
export class ItemTrace {
  /** 所属 trace ID（供外部读取，如写入 food_record.parse_log_id） */
  readonly traceId: string;
  private itemIndex: number;
  private seq: number = 0;
  private state: Record<string, unknown>;

  constructor(traceId: string, itemIndex: number, initialState?: Record<string, unknown>) {
    this.traceId = traceId;
    this.itemIndex = itemIndex;
    this.state = initialState ? { ...initialState } : createEmptyState();
  }

  /** 读取当前 state 快照（用于构建 stateAfter） */
  getState(): Record<string, unknown> {
    return this.state;
  }

  /** 设置 envelope 中某个字段（通常在 step 之前） */
  setState(key: string, value: unknown): void {
    this.state[key] = value;
  }

  /**
   * 通用 step：以当前 state 为 state_before，stateAfter 为 state_after，seq 自增。
   * 写入后内部 state 更新为 stateAfter。
   */
  async step(
    eventType: EventType,
    stateAfter: Record<string, unknown>,
    inputState?: Record<string, unknown>,
    outputState?: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const stateBefore = { ...this.state };
    await recordEvent({
      traceId: this.traceId,
      itemIndex: this.itemIndex,
      seq: ++this.seq,
      eventType,
      stateBefore,
      stateAfter,
      inputState,
      outputState,
      meta,
    });
    this.state = { ...stateAfter };
  }

  /** 记录 normalize event：canonical → food_id 的映射过程 */
  async normalize(
    stateAfter: Record<string, unknown>,
    inputState: Record<string, unknown>,
    outputState: Record<string, unknown>,
  ): Promise<void> {
    await this.step("normalize", stateAfter, inputState, outputState, {});
  }

  /** 记录 confidence event：食物+份量置信度评估及阈值判定 */
  async confidence(
    stateAfter: Record<string, unknown>,
    inputState: Record<string, unknown>,
    outputState: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.step("confidence", stateAfter, inputState, outputState, meta);
  }

  /** 记录 decision event：路由决策（auto_commit / candidate_card / portion_card / clarify_card） */
  async decision(
    stateAfter: Record<string, unknown>,
    inputState: Record<string, unknown>,
    outputState: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.step("decision", stateAfter, inputState, outputState, meta);
  }

  /** 记录 output event：food_record 或 pending_record 的创建结果 */
  async output(
    stateAfter: Record<string, unknown>,
    inputState: Record<string, unknown>,
    outputState: Record<string, unknown>,
  ): Promise<void> {
    await this.step("output", stateAfter, inputState, outputState, {});
  }
}

// ═══════════════════════════════════════════════
// 独立 trace 函数 — correction event（不属于 ChatTrace 生命周期）
// ═══════════════════════════════════════════════

/**
 * modify update 的 correction event。
 * 在 modify 意图下，用户说"改成大份"/"不是这个，是牛肉"后，记录修改前后的状态。
 */
export async function recordModifyCorrection(opts: {
  traceId: string;
  recordId: string;
  foodId: string;
  foodName: string;
  prevState: Record<string, unknown>;
  newState: Record<string, unknown>;
  isFoodChange: boolean;
  modifyConfidence?: number;
}): Promise<void> {
  const corrSb = createEmptyState();
  corrSb.entity_type = "food_standard";
  corrSb.entity_id = opts.foodId;
  corrSb.matched_food_name = opts.foodName;
  corrSb.record_id = opts.recordId;

  const corrSa = { ...corrSb };

  await recordEvent({
    traceId: opts.traceId,
    itemIndex: 0,
    seq: 1,
    eventType: "correction",
    stateBefore: corrSb,
    stateAfter: corrSa,
    inputState: {
      source: "modify_update",
      record_id: opts.recordId,
      prev_state: opts.prevState,
    },
    outputState: { new_state: opts.newState },
    meta: {
      correction_type: opts.isFoodChange ? "food_change" : "portion_change",
      confidence: opts.modifyConfidence,
      action: "update",
    },
  });
}

/**
 * delete_confirm 的 correction event。
 * 在 pending resolve 中，用户确认删除后记录。
 */
export async function recordDeleteCorrection(opts: {
  recordId: string;
  kind: string;
  name: string;
  pendingId: string;
}): Promise<void> {
  const corrSb = createEmptyState();
  corrSb.entity_type = opts.kind === "food" ? "food_standard" : "exercise";
  corrSb.matched_food_name = opts.name;

  // 尝试从 food_record 补全上下文
  try {
    const rec = await prisma.foodRecord.findFirst({ where: { id: opts.recordId } });
    if (rec) {
      corrSb.record_id = rec.id;
      corrSb.food_confidence = rec.food_confidence;
      corrSb.portion_confidence = rec.portion_confidence;
    }
  } catch {
    // food_record 可能已被删，忽略
  }

  await recordEvent({
    traceId: "",
    itemIndex: 0,
    seq: 1,
    eventType: "correction",
    stateBefore: corrSb,
    stateAfter: createEmptyState(),
    inputState: {
      source: "pending_resolve",
      pending_id: opts.pendingId,
      type: "delete_confirm",
      name: opts.name,
    },
    outputState: { result: "deleted" },
    meta: { correction_type: "delete" },
  });
}

/**
 * pending resolve（portion_choice / food_choice）的 correction event。
 * 在用户选择了份量或食物后，food_record 创建前记录。
 */
export async function recordResolveCorrection(opts: {
  foodName: string;
  foodId: string;
  portionLabel: string;
  weightG: number;
  pendingId: string;
  pendingType: string;
  candidates: Record<string, unknown>;
}): Promise<void> {
  const corrSb = createEmptyState();
  corrSb.matched_food_name = (opts.candidates.food_name ?? opts.candidates.query) as string ?? null;
  corrSb.entity_type = "food_standard";
  corrSb.entity_id = opts.foodId;

  const corrSa: Record<string, unknown> = {
    ...corrSb,
    matched_food_name: opts.foodName,
  };

  await recordEvent({
    traceId: "",
    itemIndex: 0,
    seq: 1,
    eventType: "correction",
    stateBefore: corrSb,
    stateAfter: corrSa,
    inputState: {
      source: "pending_resolve",
      pending_id: opts.pendingId,
      ai_guess: {
        food_name: opts.candidates.food_name,
        portion_label: (opts.candidates as any).chosen_label,
        portions: opts.candidates.portions,
      },
    },
    outputState: {
      user_chose: {
        food_name: opts.foodName,
        food_id: opts.foodId,
        portion_label: opts.portionLabel,
        grams: opts.weightG,
      },
    },
    meta: {
      correction_type: "portion_change",
      grams_delta: 0,
      calories_delta: 0,
    },
  });
}
