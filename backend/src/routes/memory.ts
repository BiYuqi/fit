// Memory Center API — 语义记忆管理（MEMORY_SPEC §9.4，T56）
// 提供用户可见的记忆管理入口：浏览、删除、暂停、清除。

import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getUserMemories,
  archiveMemory,
  setMemoryPaused,
  isMemoryPaused,
  clearAllMemories,
  type ActiveMemory,
} from "../services/memory-store";

// ── 分组配置（MEMORY_SPEC §9.4 / T56 §3.7）──

const GROUP_META: Record<string, { title: string; emoji: string; order: number }> = {
  constraint:    { title: "饮食禁忌", emoji: "🚫", order: 1 },
  preference:    { title: "饮食偏好", emoji: "🌶", order: 2 },
  habit:         { title: "生活习惯", emoji: "☕", order: 3 },
  context_state: { title: "当前状态", emoji: "📍", order: 4 },
  goal:          { title: "目标",     emoji: "🎯", order: 5 },
};

interface MemoryGroup {
  type: string;
  title: string;
  emoji: string;
  count: number;
  items: Array<{
    id: string;
    type: string;
    entity: string;
    content: string;
    importance_class: string;
    repetition_count: number;
    state: string;
    score: number;
    created_at: string;
    last_accessed_at: string;
  }>;
}

function groupMemories(memories: ActiveMemory[]): { groups: MemoryGroup[]; total: number } {
  const map = new Map<string, ActiveMemory[]>();

  for (const m of memories) {
    const arr = map.get(m.type) ?? [];
    arr.push(m);
    map.set(m.type, arr);
  }

  const groups: MemoryGroup[] = [];
  let total = 0;

  for (const [type, items] of map) {
    const meta = GROUP_META[type] ?? { title: type, emoji: "📌", order: 99 };
    groups.push({
      type,
      title: meta.title,
      emoji: meta.emoji,
      count: items.length,
      items: items.map((m) => ({
        id: m.id,
        type: m.type,
        entity: m.entity,
        content: m.content,
        importance_class: m.importance_class,
        repetition_count: m.repetition_count,
        state: m.state,
        score: m.score,
        created_at: m.created_at.toISOString(),
        last_accessed_at: m.last_accessed_at.toISOString(),
      })),
    });
    total += items.length;
  }

  // 固定排序：constraint 永远第一，其余按 order 字段
  groups.sort((a, b) => {
    const oa = GROUP_META[a.type]?.order ?? 99;
    const ob = GROUP_META[b.type]?.order ?? 99;
    return oa - ob;
  });

  return { groups, total };
}

// ── Request schemas ──

const PauseBodySchema = z.object({
  paused: z.boolean(),
});

const UpdateBodySchema = z.object({
  content: z.string().min(1).max(500),
});

// ── Routes ──

export async function memoryRoutes(app: FastifyInstance) {
  const auth = (req: any, reply: any) => app.authenticate(req, reply);

  // ─────────────────────────────────────────────
  // GET /api/memory
  // 返回用户所有非 ARCHIVED 记忆，按类型分组
  // ─────────────────────────────────────────────
  app.get("/api/memory", { preHandler: [auth] }, async (req) => {
    const { sub: user_id } = req.user as { sub: string };

    const [memories, paused] = await Promise.all([
      getUserMemories(user_id),
      isMemoryPaused(user_id),
    ]);

    const grouped = groupMemories(memories);

    return {
      groups: grouped.groups,
      total: grouped.total,
      paused,
    };
  });

  // ─────────────────────────────────────────────
  // PATCH /api/memory/:id
  // 更新单条记忆的 content（用户手动修改）
  // ─────────────────────────────────────────────
  app.patch("/api/memory/:id", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const { id } = req.params as { id: string };

    const bodyParsed = UpdateBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: { code: "invalid_input", message: bodyParsed.error.message },
      });
    }

    // 验证所有权：只能改自己的记忆
    const { getMemoryById, upsertMemory } = await import("../services/memory-store");
    const existing = await getMemoryById(id);
    if (!existing) {
      return reply.status(404).send({ error: { code: "not_found", message: "记忆不存在" } });
    }

    // 注意：getMemoryById 不返回 user_id（ActiveMemory 不含此字段），
    // 通过 raw query 验证所有权
    const { prisma } = await import("../lib/prisma");
    const row = await prisma.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM "UserMemory" WHERE id = ${id} LIMIT 1
    `;
    if (!row.length || row[0].user_id !== user_id) {
      return reply.status(403).send({ error: { code: "forbidden", message: "无权修改" } });
    }

    await prisma.$executeRaw`
      UPDATE "UserMemory"
      SET content = ${bodyParsed.data.content},
          updated_at = ${new Date().toISOString()}::timestamptz
      WHERE id = ${id}
    `;

    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // DELETE /api/memory/:id
  // 软删除单条记忆（设 ARCHIVED）
  // ─────────────────────────────────────────────
  app.delete("/api/memory/:id", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const { id } = req.params as { id: string };

    // 验证所有权
    const { prisma } = await import("../lib/prisma");
    const row = await prisma.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM "UserMemory" WHERE id = ${id} LIMIT 1
    `;
    if (!row.length) {
      return reply.status(404).send({ error: { code: "not_found", message: "记忆不存在" } });
    }
    if (row[0].user_id !== user_id) {
      return reply.status(403).send({ error: { code: "forbidden", message: "无权删除" } });
    }

    await archiveMemory(id);
    return { ok: true };
  });

  // ─────────────────────────────────────────────
  // POST /api/memory/pause
  // 暂停/恢复 AI 记忆提取（toggle）
  // ─────────────────────────────────────────────
  app.post("/api/memory/pause", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };

    const bodyParsed = PauseBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        error: { code: "invalid_input", message: bodyParsed.error.message },
      });
    }

    await setMemoryPaused(user_id, bodyParsed.data.paused);
    return { ok: true, paused: bodyParsed.data.paused };
  });

  // ─────────────────────────────────────────────
  // DELETE /api/memory/clear
  // 批量软删除所有记忆（清除所有记忆）
  // ─────────────────────────────────────────────
  app.delete("/api/memory/clear", { preHandler: [auth] }, async (req) => {
    const { sub: user_id } = req.user as { sub: string };
    const count = await clearAllMemories(user_id);
    return { ok: true, deleted: count };
  });
}
