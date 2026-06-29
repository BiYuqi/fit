import fp from "fastify-plugin";
import jwt from "@fastify/jwt";

export default fp(async (app) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set");

  await app.register(jwt, { secret });

  app.decorate("authenticate", async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch {
      reply.status(401).send({ error: { code: "unauthorized", message: "Missing or invalid token" } });
    }
  });
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: any, reply: any) => Promise<void>;
  }
}
