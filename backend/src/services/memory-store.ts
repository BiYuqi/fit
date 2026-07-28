// Memory Store — 语义记忆 CRUD（MEMORY_SPEC §6-7）
// 提供混合检索、写入、维护操作。embedding 列通过 raw SQL 操作以绕过
// Prisma Unsupported 类型限制（pgvector 非 Prisma 原生支持）。

import { prisma } from "../lib/prisma";
import { getClient } from "../ai/client";
import {
  computeScore,
  decideStateWithFloor,
  daysBetween,
  clamp,
  type MemoryType,
  type ImportanceClass,
  type MemoryState,
} from "./memory-scorer";

// ── Types ──

export interface MemoryCandidate {
  type: MemoryType;
  entity: string;
  content: string;
  llm_confidence: number;
  importance_class: ImportanceClass;
  source_type?: string;
  source_message_id?: string;
  source_text?: string;
  /** 相对天数，绝对日期由 store 层换算（T75 口径 5）。null/省略 → 走类型默认 TTL */
  expires_in_days?: number | null;
}

export interface ActiveMemory {
  id: string;
  type: MemoryType;
  entity: string;
  content: string;
  llm_confidence: number;
  importance_class: ImportanceClass;
  repetition_count: number;
  state: MemoryState;
  source_type: string;
  source_message_id: string | null;
  source_text: string | null;
  expires_at: Date | null;
  valid_from: Date;
  valid_to: Date | null;
  last_accessed_at: Date;
  created_at: Date;
  score: number; // 实时计算，不落库
}

export interface MemoryGroups {
  constraints: ActiveMemory[];
  contextGoals: ActiveMemory[];
  prefsHabits: ActiveMemory[];
}

// ── Embedding ──

const EMBEDDING_MODEL = "deepseek-chat";
const EMBEDDING_DIM = 1024;

/**
 * 调用 DeepSeek embedding API 生成 1024 维向量。
 * 失败返回 null——embedding 是 preference/habit 语义检索的加速手段，
 * 不可用时退化到 score 排序，不影响核心功能。
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const client = getClient();
    const resp = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8192), // 截断超长文本
    });
    const emb = resp.data[0]?.embedding;
    if (!emb || emb.length !== EMBEDDING_DIM) {
      console.warn(`generateEmbedding: unexpected dim ${emb?.length}, expected ${EMBEDDING_DIM}`);
      return null;
    }
    return emb;
  } catch (err) {
    console.warn("generateEmbedding failed:", err);
    return null;
  }
}

/** 将 number[] 格式化为 pgvector 字面量 */
function vecLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

// ── Score computation helper ──

function attachScore(row: Record<string, unknown>, now: Date): ActiveMemory {
  const type = row.type as MemoryType;
  // 过期判定豁免 medical：与检索 SQL 里 constraint 段不加过期过滤是**同一条底线**（T74 口径 3）。
  // 只堵检索那一侧不够——过期惩罚 × 0.2 会让 score 崩到 0.17，decideStateWithFloor 虽然
  // 拦住了 ARCHIVED，但落到 WEAK 时检索 SQL 的 state = 'ACTIVE' 已经把它过滤掉了。
  // 「医疗类不会自动消失」要守的是"不会自动停止注入"，而 WEAK 就已经不注入了。
  const expired =
    row.expires_at != null &&
    new Date(row.expires_at as string) <= now &&
    row.importance_class !== "medical";
  const score = computeScore({
    llm_confidence: row.llm_confidence as number,
    type,
    importance_class: (row.importance_class ?? "normal") as ImportanceClass,
    repetition_count: (row.repetition_count as number) ?? 1,
    days_since_last_access: daysBetween(now, new Date(row.last_accessed_at as string)),
    expired,
  });
  return {
    id: row.id as string,
    type,
    entity: row.entity as string,
    content: row.content as string,
    llm_confidence: row.llm_confidence as number,
    importance_class: (row.importance_class ?? "normal") as ImportanceClass,
    repetition_count: (row.repetition_count as number) ?? 1,
    state: row.state as MemoryState,
    source_type: (row.source_type as string) ?? "explicit_user",
    source_message_id: row.source_message_id as string | null,
    source_text: row.source_text as string | null,
    expires_at: row.expires_at ? new Date(row.expires_at as string) : null,
    valid_from: new Date(row.valid_from as string),
    valid_to: row.valid_to ? new Date(row.valid_to as string) : null,
    last_accessed_at: new Date(row.last_accessed_at as string),
    created_at: new Date(row.created_at as string),
    score,
  };
}

// ── Hybrid Retrieval（MEMORY_SPEC §7.1）──

/**
 * 混合检索：constraint 全量 SQL + context_state/goal score top-3
 * + preference/habit embedding 语义召回 top-5。
 *
 * @param queryText 用户最新消息，用于 preference/habit 的 embedding 相似度检索。
 *   未提供时退化到 score 排序。
 */
export async function loadActiveMemories(
  userId: string,
  queryText?: string,
): Promise<MemoryGroups> {
  const now = new Date();

  // 1. constraint：全量拉取，不走 embedding，不受 top-5 限制（安全优先）
  const constraintRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "UserMemory"
    WHERE user_id = ${userId}      AND type = 'constraint'
      AND state = 'ACTIVE'
    ORDER BY created_at DESC
  `;

  // 2. context_state + goal：全部 ACTIVE 且未过期，应用层算 score，取 top-3
  //
  // 过期过滤只加在这一段（T75）。constraint 段**故意不加**：T74 立的规矩是医疗类
  // 记忆绝不自动消失、只有用户能在记忆中心手动删，而这个条件会绕过它——只要有任何
  // 来源给一条 medical constraint 写了 expires_at，一条过敏记忆就会被静默不注入，
  // 而 state 还是 ACTIVE、记忆中心照常显示"生效中"。preference/habit 不引入 TTL，
  // 加了是恒真条件。
  const cgRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "UserMemory"
    WHERE user_id = ${userId}      AND state = 'ACTIVE'
      AND type IN ('context_state', 'goal')
      AND (expires_at IS NULL OR expires_at > now())
  `;

  // 3. preference + habit：embedding 语义召回 top-5，退化到 score 排序
  let phRows: Record<string, unknown>[];
  if (queryText) {
    const emb = await generateEmbedding(queryText);
    if (emb) {
      phRows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT *, embedding <=> ${vecLiteral(emb)}::vector AS _distance
        FROM "UserMemory"
        WHERE user_id = ${userId}          AND state = 'ACTIVE'
          AND type IN ('preference', 'habit')
        ORDER BY _distance
        LIMIT 5
      `;
    } else {
      // 退化：无 embedding 时全量 + score 排序
      phRows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM "UserMemory"
        WHERE user_id = ${userId}          AND state = 'ACTIVE'
          AND type IN ('preference', 'habit')
      `;
    }
  } else {
    // 无 queryText：全量 + score 排序
    phRows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "UserMemory"
      WHERE user_id = ${userId}        AND state = 'ACTIVE'
        AND type IN ('preference', 'habit')
    `;
  }

  const constraints = constraintRows.map((r) => attachScore(r, now));
  const contextGoals = cgRows
    .map((r) => attachScore(r, now))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const prefsHabits = phRows
    .map((r) => attachScore(r, now))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return { constraints, contextGoals, prefsHabits };
}

// ── CRUD ──

/** 未给 TTL 时的兜底过期天数（T75 口径 2）。
 *
 *  只有 context_state 兜底，且 14 天与 λ=0.015 掉到 ACTIVE_DOWN 的时间（~13.9 天）对齐，
 *  两条机制不打架。goal **不**兜底：首次 goal 的分数上限是
 *  0.9 × 0.80 × rep_boost(1)=0.70 = 0.504 < ACTIVE_UP.goal(0.65)，本就进不了 ACTIVE，
 *  给一个永远不被检索的类型填过期时间是给死代码加死代码。 */
const DEFAULT_TTL_DAYS: Partial<Record<MemoryType, number>> = {
  context_state: 14,
};

/**
 * 相对天数 → 绝对过期时刻（T75 口径 5）。
 *
 * 提取侧只输出 `expires_in_days`，绝对日期一律在这里算：两条提取路径的 prompt 都没有
 * "今天是几号"，让模型填 ISO 日期它只会照抄 few-shot 里的字面量，产出一个已经过去的
 * 日期——叠加检索层的过期过滤，新记的记忆会一出生就过期且零报错。
 *
 * 落在当天**本地时** 23:59:59，而不是 UTC 午夜——后者在 UTC+8 下会提前 16 小时失效。
 */
function resolveExpiry(
  type: MemoryType,
  days: number | null | undefined,
  now: Date,
): Date | null {
  const d = days ?? DEFAULT_TTL_DAYS[type] ?? null;
  if (d == null || d <= 0) return null;
  const at = new Date(now);
  at.setDate(at.getDate() + d);
  at.setHours(23, 59, 59, 999);
  return at;
}

/**
 * Upsert 一条记忆。同 (user_id, type, entity) 则覆盖 content、累加 repetition_count
 * 并刷新 last_accessed_at；新 entity 则新建。
 *
 * state 用**本次写入后的真实 repetition_count** 重算——第 n 次提及就按 rep_boost(n) 算，
 * 不再硬编码 1（否则强化只能等凌晨 cron 补，T74 修）。
 *
 * 返回带实时 score 的记忆对象。
 */
export async function upsertMemory(
  userId: string,
  candidate: MemoryCandidate,
): Promise<ActiveMemory> {
  const now = new Date();

  // 先读已有行，拿到真实 repetition_count 和当前 state 作为 decideState 的基线
  const existing = await prisma.$queryRaw<
    { repetition_count: number; state: string }[]
  >`
    SELECT repetition_count, state FROM "UserMemory"
    WHERE user_id = ${userId}
      AND type = ${candidate.type}
      AND entity = ${candidate.entity}
    LIMIT 1
  `;
  const prev = existing[0];
  const nextRep = prev ? prev.repetition_count + 1 : 1;
  // 被作废/降级过的记忆重新被提及 → 以 WEAK 为基线重新判定，允许复活
  const baseState: MemoryState =
    prev && prev.state !== "ARCHIVED" ? (prev.state as MemoryState) : "WEAK";

  const initScore = computeScore({
    llm_confidence: candidate.llm_confidence,
    type: candidate.type,
    importance_class: candidate.importance_class,
    repetition_count: nextRep,
    days_since_last_access: 0,
  });
  const initState = decideStateWithFloor(
    candidate.type,
    candidate.importance_class,
    initScore,
    baseState,
  );

  const expiresAt = resolveExpiry(candidate.type, candidate.expires_in_days, now);

  // 生成 embedding（偏好/习惯需要语义检索）
  // TODO: DeepSeek 无 embedding 端点（/v1/embeddings 404），暂跳过。
  // 后续可接 OpenAI text-embedding-3-small 或本地模型。
  // 当前 preference/habit 检索退化到 score 排序，数据量小时无影响。
  const emb = null; // await generateEmbedding(candidate.content);
  const embParam = null; // JS null → SQL NULL bind param

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "UserMemory" (
      id, user_id, type, entity, content,
      llm_confidence, importance_class, repetition_count, state,
      source_type, source_message_id, source_text,
      expires_at, valid_from, embedding, last_accessed_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      ${userId},
      ${candidate.type},
      ${candidate.entity},
      ${candidate.content},
      ${candidate.llm_confidence},
      ${candidate.importance_class},
      1,
      ${initState},
      ${candidate.source_type ?? "explicit_user"},
      ${candidate.source_message_id ? `${candidate.source_message_id}` : null},
      ${candidate.source_text ?? null},
      ${expiresAt ? expiresAt.toISOString() : null}::timestamptz,
      ${now.toISOString()}::timestamptz,
      ${embParam}::vector,
      ${now.toISOString()}::timestamptz,
      ${now.toISOString()}::timestamptz
    )
    ON CONFLICT (user_id, type, entity)
    DO UPDATE SET
      llm_confidence = EXCLUDED.llm_confidence,
      importance_class = EXCLUDED.importance_class,
      repetition_count = ${nextRep},
      state = ${initState},
      content = EXCLUDED.content,
      valid_to = NULL,
      source_message_id = COALESCE(EXCLUDED.source_message_id, "UserMemory".source_message_id),
      source_text = COALESCE(EXCLUDED.source_text, "UserMemory".source_text),
      -- 用户重新提起一条临时状态 → TTL 顺延（"还在出差"），符合直觉
      expires_at = EXCLUDED.expires_at,
      embedding = COALESCE(${embParam}::vector, "UserMemory".embedding),
      updated_at = ${now.toISOString()}::timestamptz,
      last_accessed_at = ${now.toISOString()}::timestamptz
    RETURNING *
  `;

  return attachScore(rows[0], now);
}

/** 作废阈值：低于此置信度只降权，不作废（T74 口径 2） */
const INVALIDATE_CONFIDENCE_MIN = 0.8;

/** 医疗类记忆降权的置信度地板（T74 口径 3）。
 *
 *  同一句否认会被处理两次——同步 quickExtract 一次，异步 fullExtract 读最近 5 条
 *  用户消息时又一次。置信度每次折半，0.95 两轮后就是 0.2375，score 掉到 0.40 以下，
 *  decideState 直接判 ARCHIVED——"医疗类绝不自动作废"这条底线就靠调用次数守着了，守不住。
 *  所以底线写死在这里：医疗类降权有地板，且状态永不落到 ARCHIVED。 */
const MEDICAL_CONFIDENCE_FLOOR = 0.3;

export type InvalidateResult = "invalidated" | "demoted" | "not_found";

/**
 * 用户否认了一条记忆 → 作废通道（T74，MEMORY_SPEC §5.5 实现注记）。
 *
 * - `importance_class = 'medical'`（过敏/诊断）→ **只降权不作废**。LLM 分不清
 *   "我不过敏了" 和 "我这次吃了没过敏"，误删一条花生过敏的代价太大，
 *   由用户自己去记忆中心手动删。
 * - 置信度不足 → 同样只降权（§5.5 的 else 分支：score 减半）。
 * - 否则 → `valid_to = now()` + `state = 'ARCHIVED'`，保留"用户在这个时间点变了"
 *   的轨迹，90 天后由 deleteExpiredMemories 自然清理，期间用户仍能在记忆中心看到。
 */
export async function invalidateMemory(
  userId: string,
  type: MemoryType,
  entity: string,
  opts: { reason: string; llmConfidence: number },
): Promise<InvalidateResult> {
  const now = new Date();
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "UserMemory"
    WHERE user_id = ${userId}
      AND type = ${type}
      AND entity = ${entity}
      AND state IN ('ACTIVE', 'WEAK')
  `;
  if (rows.length === 0) return "not_found";

  const isMedical = rows.some((r) => r.importance_class === "medical");
  const demoteOnly = isMedical || opts.llmConfidence < INVALIDATE_CONFIDENCE_MIN;

  if (demoteOnly) {
    for (const row of rows) {
      const rowMedical = row.importance_class === "medical";
      const halved = clamp(
        (row.llm_confidence as number) / 2,
        rowMedical ? MEDICAL_CONFIDENCE_FLOOR : 0,
        1,
      );
      const score = computeScore({
        llm_confidence: halved,
        type,
        importance_class: (row.importance_class ?? "normal") as ImportanceClass,
        repetition_count: (row.repetition_count as number) ?? 1,
        days_since_last_access: daysBetween(
          now,
          new Date(row.last_accessed_at as string),
        ),
      });
      const nextState = decideStateWithFloor(
        type,
        (row.importance_class ?? "normal") as ImportanceClass,
        score,
        row.state as MemoryState,
      );
      await prisma.$executeRaw`
        UPDATE "UserMemory"
        SET llm_confidence = ${halved},
            state = ${nextState},
            updated_at = ${now.toISOString()}::timestamptz
        WHERE id = ${row.id as string}
      `;
    }
    return "demoted";
  }

  for (const row of rows) {
    await prisma.$executeRaw`
      UPDATE "UserMemory"
      SET state = 'ARCHIVED',
          valid_to = ${now.toISOString()}::timestamptz,
          source_text = ${`${row.source_text ?? ""}\n[作废] ${opts.reason}`.trim()},
          updated_at = ${now.toISOString()}::timestamptz
      WHERE id = ${row.id as string}
    `;
  }
  return "invalidated";
}

/** 软删除：设 state = ARCHIVED */
export async function archiveMemory(memoryId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "UserMemory"
    SET state = 'ARCHIVED',
        updated_at = ${new Date().toISOString()}::timestamptz
    WHERE id = ${memoryId}  `;
}

/** 硬删除 ARCHIVED 且 created_at > 90 天的记忆（每周 cron 调用） */
export async function deleteExpiredMemories(userId: string): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);

  const result = await prisma.$executeRaw`
    DELETE FROM "UserMemory"
    WHERE user_id = ${userId}      AND state = 'ARCHIVED'
      AND created_at < ${cutoff.toISOString()}::timestamptz
  `;
  // $executeRaw returns number of affected rows in Prisma 7
  return result;
}

/** 获取用户所有非 ARCHIVED 记忆（Memory Center 用） */
export async function getUserMemories(
  userId: string,
): Promise<ActiveMemory[]> {
  const now = new Date();
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "UserMemory"
    WHERE user_id = ${userId}      AND state IN ('ACTIVE', 'WEAK')
    ORDER BY type, created_at DESC
  `;
  return rows.map((r) => attachScore(r, now));
}

/** 按 memoryId 获取单条记忆（含实时 score） */
export async function getMemoryById(
  memoryId: string,
): Promise<ActiveMemory | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "UserMemory"
    WHERE id = ${memoryId}  `;
  if (rows.length === 0) return null;
  return attachScore(rows[0], new Date());
}

/** 暂停/恢复提取（toggle：更新 user 元数据的 memory_paused 字段）
 *
 *  注意：当前 User 表无 memory_paused 字段，所以这里用一个轻量标记。
 *  在 Phase 3 中，引入独立的 user_settings 表或复用现有机制。
 *  当前实现：直接操作 user_memory 表的一个 system 行来存储状态。
 *  如果用户表新增了 `memory_paused` 字段，替换这里的实现。
 */
export async function setMemoryPaused(
  userId: string,
  paused: boolean,
): Promise<void> {
  // 用一条 type='system' 的 memory 行记录暂停状态
  // 这是 Phase 1 的临时方案；Phase 3 移到 user 表字段或 user_settings 表
  await prisma.$executeRaw`
    INSERT INTO "UserMemory" (
      id, user_id, type, entity, content,
      llm_confidence, importance_class, repetition_count, state,
      source_type, last_accessed_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      ${userId},
      'constraint',
      '_system',
      ${paused ? 'memory_paused' : 'memory_active'},
      1.0, 'normal', 1, 'ACTIVE',
      'explicit_user',
      ${new Date().toISOString()}::timestamptz,
      ${new Date().toISOString()}::timestamptz
    )
    ON CONFLICT (user_id, type, entity)
    DO UPDATE SET
      content = EXCLUDED.content,
      updated_at = ${new Date().toISOString()}::timestamptz,
      last_accessed_at = ${new Date().toISOString()}::timestamptz
  `;
}

/** 查询是否暂停记忆提取 */
export async function isMemoryPaused(userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT content FROM "UserMemory"
    WHERE user_id = ${userId}      AND type = 'constraint'
      AND entity = '_system'
    LIMIT 1
  `;
  return rows.length > 0 && rows[0].content === "memory_paused";
}

/** 批量软删除用户所有记忆（清除所有记忆功能） */
export async function clearAllMemories(userId: string): Promise<number> {
  const result = await prisma.$executeRaw`
    UPDATE "UserMemory"
    SET state = 'ARCHIVED',
        updated_at = ${new Date().toISOString()}::timestamptz
    WHERE user_id = ${userId}      AND state IN ('ACTIVE', 'WEAK')
  `;
  return result;
}

/** 计算并刷新所有非 ARCHIVED 记忆的 state（每日 cron 调用） */
export async function recalcAndPrune(userId: string): Promise<{
  demotedToWeak: number;
  demotedToArchived: number;
}> {
  const now = new Date();
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "UserMemory"
    WHERE user_id = ${userId}      AND state IN ('ACTIVE', 'WEAK')
      AND NOT (type = 'constraint' AND entity = '_system')
  `;

  let demotedToWeak = 0;
  let demotedToArchived = 0;

  for (const row of rows) {
    const withScore = attachScore(row, now);
    const newState = decideStateWithFloor(
      withScore.type,
      withScore.importance_class,
      withScore.score,
      row.state as MemoryState,
    );

    if (newState !== row.state) {
      await prisma.$executeRaw`
        UPDATE "UserMemory"
        SET state = ${newState},
            updated_at = ${now.toISOString()}::timestamptz
        WHERE id = ${row.id as string}      `;
      if (newState === "WEAK") demotedToWeak++;
      if (newState === "ARCHIVED") demotedToArchived++;
    }
  }

  // 硬上限检查（MEMORY_SPEC §8.3）
  await enforceHardLimits(userId);

  return { demotedToWeak, demotedToArchived };
}

/** 硬上限：ACTIVE > 100 → 最低 score 降为 WEAK；WEAK > 300 → 最低 score 降为 ARCHIVED */
async function enforceHardLimits(userId: string): Promise<void> {
  const now = new Date();

  // ACTIVE 上限
  const activeRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, type, llm_confidence, importance_class, repetition_count,
           expires_at, last_accessed_at, state
    FROM "UserMemory"
    WHERE user_id = ${userId} AND state = 'ACTIVE'
      AND NOT (type = 'constraint' AND entity = '_system')
    ORDER BY created_at ASC
  `;
  const activeWithScore = activeRows.map((r) => attachScore(r, now));
  if (activeWithScore.length > 100) {
    const toDemote = activeWithScore
      .sort((a, b) => a.score - b.score)
      .slice(0, activeWithScore.length - 100);
    for (const m of toDemote) {
      await prisma.$executeRaw`
        UPDATE "UserMemory" SET state = 'WEAK',
          updated_at = ${now.toISOString()}::timestamptz
        WHERE id = ${m.id}      `;
    }
  }

  // WEAK 上限
  const weakCount = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int as count FROM "UserMemory"
    WHERE user_id = ${userId} AND state = 'WEAK'
  `;
  if (weakCount[0]?.count > 300) {
    const over = weakCount[0].count - 300;
    await prisma.$executeRaw`
      UPDATE "UserMemory"
      SET state = 'ARCHIVED',
          updated_at = ${now.toISOString()}::timestamptz
      WHERE id IN (
        SELECT id FROM "UserMemory"
        WHERE user_id = ${userId} AND state = 'WEAK'
        ORDER BY created_at ASC
        LIMIT ${over}
      )
    `;
  }
}
