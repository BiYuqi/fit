import "dotenv/config";
import cors from "@fastify/cors";
import Fastify from "fastify";
import cron from "node-cron";
import jwtPlugin from "./plugins/jwt";
import { prisma } from "./lib/prisma";
import { recalcAndPrune, deleteExpiredMemories } from "./services/memory-store";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/user";
import { chatRoutes } from "./routes/chat";
import { chatHistoryRoutes } from "./routes/chat-history";
import { pendingRoutes } from "./routes/pending";
import { recordsRoutes } from "./routes/records";
import { dailyRoutes } from "./routes/daily";
import { memoryRoutes } from "./routes/memory";

const app = Fastify({ logger: true });

app.register(cors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});
app.register(jwtPlugin);
app.register(authRoutes);
app.register(userRoutes);
app.register(chatRoutes);
app.register(chatHistoryRoutes);
app.register(pendingRoutes);
app.register(recordsRoutes);
app.register(dailyRoutes);
app.register(memoryRoutes);

// 公共路由
app.get("/api/health", async () => ({ ok: true }));

// 受保护路由（用于验收；后续真实路由替换这里）
// preHandler 用箭头函数包一层，确保在调用时才读 app.authenticate（注册后才存在）
app.get(
  "/api/me",
  { preHandler: [(req, reply) => app.authenticate(req, reply)] },
  async (req) => {
    const { sub } = req.user as { sub: string };
    return { user_id: sub };
  }
);

// ── 语义记忆维护 cron（MEMORY_SPEC §8.2，T56）──

/** 获取所有有记忆的用户 ID 列表 */
async function getMemoryUserIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ user_id: string }[]>`
    SELECT DISTINCT user_id FROM "UserMemory"
    WHERE NOT (type = 'constraint' AND entity = '_system')
  `;
  return rows.map((r) => r.user_id);
}

// 每日凌晨 3:00：重算 score + 降级状态（ACTIVE_DOWN 以下→WEAK，<0.40→ARCHIVED）
cron.schedule("0 3 * * *", async () => {
  console.log("[cron] daily memory recalc starting");
  try {
    const userIds = await getMemoryUserIds();
    let totalDemotedWeak = 0;
    let totalDemotedArchived = 0;
    for (const uid of userIds) {
      const r = await recalcAndPrune(uid);
      totalDemotedWeak += r.demotedToWeak;
      totalDemotedArchived += r.demotedToArchived;
    }
    console.log(`[cron] daily memory recalc done: ${userIds.length} users, ${totalDemotedWeak}→WEAK, ${totalDemotedArchived}→ARCHIVED`);
  } catch (err) {
    console.error("[cron] daily memory recalc failed:", err);
  }
});

// 每周日 4:00：硬删除 ARCHIVED+90天 + 硬上限检查
cron.schedule("0 4 * * 0", async () => {
  console.log("[cron] weekly memory cleanup starting");
  try {
    const userIds = await getMemoryUserIds();
    let totalDeleted = 0;
    for (const uid of userIds) {
      const n = await deleteExpiredMemories(uid);
      totalDeleted += n;
    }
    console.log(`[cron] weekly memory cleanup done: ${userIds.length} users, ${totalDeleted} hard-deleted`);
  } catch (err) {
    console.error("[cron] weekly memory cleanup failed:", err);
  }
});

const port = Number(process.env.PORT) || 9300;
app.listen({ port, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
