import "dotenv/config";
import Fastify from "fastify";
import jwtPlugin from "./plugins/jwt";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/user";
import { chatRoutes } from "./routes/chat";
import { dailyRoutes } from "./routes/daily";

const app = Fastify({ logger: true });

app.register(jwtPlugin);
app.register(authRoutes);
app.register(userRoutes);
app.register(chatRoutes);
app.register(dailyRoutes);

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

const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
