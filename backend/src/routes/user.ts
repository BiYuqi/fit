import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { bmr, tdee, dailyTargets } from "../services/calc";
import type { UserProfile, Sex, ActivityLevel } from "../services/calc";
import type { User } from "@prisma/client";
import { upsertWeightLog } from "../services/learning";

const PutBodySchema = z.object({
  name: z.string().max(64).optional(),
  gender: z.enum(["male", "female"]).optional(),
  age: z.number().int().min(10).max(120).optional(),
  height_cm: z.number().min(50).max(300).optional(),
  weight_kg: z.number().min(20).max(500).optional(),
  target_weight_kg: z.number().min(20).max(500).optional(),
  activity_level: z.enum(["sedentary", "light", "moderate", "active", "very_active"]).optional(),
  goal_type: z.enum(["cut", "maintain"]).optional(),
  daily_deficit: z.number().int().min(0).max(1500).optional(),
  custom_tdee: z.number().int().min(800).max(6000).optional(),
});

function computeDerived(user: User) {
  if (
    !user.gender || user.age == null ||
    !user.height_cm || !user.weight_kg || !user.activity_level
  ) return null;

  const profile: UserProfile = {
    sex: user.gender as Sex,
    age: user.age,
    height_cm: Number(user.height_cm),
    weight_kg: Number(user.weight_kg),
    activity_level: user.activity_level as ActivityLevel,
    daily_deficit: user.daily_deficit,
  };

  const td = user.custom_tdee != null ? user.custom_tdee : Math.round(tdee(profile) * 10) / 10;
  const b = Math.round(bmr(profile) * 10) / 10;
  const deficit = user.daily_deficit ?? 500;
  const target_calories = Math.round(td - deficit);
  const target_protein_g = Math.round(Number(user.weight_kg) * 1.8);

  return {
    bmr: b,
    tdee: td,
    target_calories,
    target_protein: target_protein_g,
  };
}

function formatUser(user: User) {
  return {
    id: user.id,
    account: user.account,
    name: user.name,
    gender: user.gender,
    age: user.age,
    height_cm: user.height_cm ? Number(user.height_cm) : null,
    weight_kg: user.weight_kg ? Number(user.weight_kg) : null,
    target_weight_kg: user.target_weight_kg ? Number(user.target_weight_kg) : null,
    activity_level: user.activity_level,
    goal_type: user.goal_type,
    daily_deficit: user.daily_deficit,
    custom_tdee: user.custom_tdee,
    onboarded: user.onboarded,
    created_at: user.created_at,
    ...computeDerived(user),
  };
}

export async function userRoutes(app: FastifyInstance) {
  const auth = { preHandler: [(req: any, reply: any) => app.authenticate(req, reply)] };

  // GET /api/user/profile
  app.get("/api/user/profile", auth, async (req) => {
    const { sub } = req.user as { sub: string };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sub } });
    return formatUser(user);
  });

  // PUT /api/user/profile
  app.put("/api/user/profile", auth, async (req, reply) => {
    const { sub } = req.user as { sub: string };

    const parsed = PutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: parsed.error.message } });
    }

    const data = parsed.data;

    // 学习信号（LEARNING_SPEC §8）：体重变化时顺手留一条历史点，供 T34 地面真值校准
    let prevWeightKg: number | null = null;
    if (data.weight_kg !== undefined) {
      const prev = await prisma.user.findUnique({ where: { id: sub }, select: { weight_kg: true } });
      prevWeightKg = prev?.weight_kg != null ? Number(prev.weight_kg) : null;
    }

    const updated = await prisma.user.update({
      where: { id: sub },
      data: {
        ...data,
        // 只要本次 PUT 后档案字段齐全就置 onboarded
        onboarded: true,
      },
    });

    if (data.weight_kg !== undefined && data.weight_kg !== prevWeightKg) {
      upsertWeightLog(sub, data.weight_kg);
    }

    return formatUser(updated);
  });
}
