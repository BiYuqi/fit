import { FastifyInstance } from "fastify";
import { z } from "zod";
import * as argon2 from "argon2";
import { prisma } from "../lib/prisma";

const BodySchema = z.object({
  account: z.string().min(1).max(64),
  password: z.string().min(6).max(128),
});

export async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/register
  app.post("/api/auth/register", async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: parsed.error.message } });
    }
    const { account, password } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { account } });
    if (existing) {
      return reply.status(409).send({ error: { code: "account_taken", message: "Account already exists" } });
    }

    const password_hash = await argon2.hash(password);
    const user = await prisma.user.create({ data: { account, password_hash } });

    const token = app.jwt.sign({ sub: user.id });
    return reply.status(201).send({ token });
  });

  // POST /api/auth/login
  app.post("/api/auth/login", async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: parsed.error.message } });
    }
    const { account, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { account } });
    if (!user) {
      return reply.status(401).send({ error: { code: "invalid_credentials", message: "Invalid account or password" } });
    }

    const valid = await argon2.verify(user.password_hash, password);
    if (!valid) {
      return reply.status(401).send({ error: { code: "invalid_credentials", message: "Invalid account or password" } });
    }

    const token = app.jwt.sign({ sub: user.id });
    return reply.send({ token });
  });
}
