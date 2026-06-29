import { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseUserInput } from "../services/parser";
import { matchFood, matchFoodCandidates } from "../services/matcher";
import { itemNutrition } from "../services/calc";
import { recompute, buildContextCard } from "../services/summary";
import { callDeepSeek } from "../ai/client";
import { prisma } from "../lib/prisma";
import type { MealType, PortionLabel } from "@prisma/client";

// ---------- 运动 MET 简表（中英双语关键词） ----------
const MET_TABLE: Array<[string[], number]> = [
  [["跑步", "慢跑", "running", "jogging"], 8],
  [["骑车", "骑行", "cycling", "bicycle"], 6],
  [["游泳", "swimming"], 7],
  [["力量", "举铁", "健身", "strength", "weightlifting"], 5],
  [["瑜伽", "yoga", "拉伸", "stretching"], 2.5],
  [["HIIT", "高强度", "interval"], 9],
  [["有氧", "aerobics"], 6.5],
  [["散步", "walking", "步行"], 3.5],
  [["爬山", "hiking"], 6],
  [["篮球", "basketball", "足球", "soccer", "football"], 7],
  [["乒乓", "table tennis", "羽毛球", "badminton", "网球", "tennis"], 5],
  [["跳绳", "jump rope", "jumping"], 10],
];

function getMET(type: string): number {
  const lower = type.toLowerCase();
  for (const [keywords, met] of MET_TABLE) {
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) return met;
  }
  return 4;
}

function calcExerciseCalories(type: string, duration_min: number, weight_kg: number): number {
  return Math.round(getMET(type) * weight_kg * (duration_min / 60));
}

// ---------- 工具函数 ----------
function todayStr(): string {
  // UTC+8 (Asia/Shanghai): shift to local midnight
  const local = new Date(Date.now() + 8 * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

function toDateOnly(date: string): Date {
  return new Date(date + "T00:00:00.000Z");
}

function guessMealType(): MealType {
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return "breakfast";
  if (h >= 10 && h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  return "snack";
}

async function answerQuery(question: string, card: object): Promise<string> {
  const res = await callDeepSeek(
    [
      {
        role: "system",
        content: `你是减脂助手，根据用户今日数据回答问题，数字来自以下上下文卡（单位 kcal/g），回答简洁中文：\n${JSON.stringify(card)}`,
      },
      { role: "user", content: question },
    ],
    { model: "deepseek-v4-flash" }
  );
  return res.choices[0]?.message?.content ?? "暂时无法回答";
}

async function answerChat(text: string): Promise<string> {
  const res = await callDeepSeek(
    [
      {
        role: "system",
        content: `你是一个减脂健康助手，只回答与饮食、营养、运动、减脂、体重管理相关的问题，回答简洁，使用中文。
如果用户的问题与以上主题无关（如聊天、情感、时事、编程、娱乐等），请礼貌拒绝，回复：「这个问题超出我的服务范围啦～我只能帮你解答饮食、营养和运动相关的问题，有减脂方面的疑问随时告诉我 💪」`,
      },
      { role: "user", content: text },
    ],
    { model: "deepseek-v4-flash" }
  );
  return res.choices[0]?.message?.content ?? "好的";
}

// ---------- 请求 schema ----------
const MessageBodySchema = z.object({
  text: z.string().min(1).max(2000),
  source: z.enum(["text", "voice"]).default("text"),
});

const ResolveBodySchema = z.object({
  choice: z.union([
    z.string().min(1),
    z.object({ grams: z.number().positive() }),
  ]),
});

// ---------- 路由 ----------
export async function chatRoutes(app: FastifyInstance) {
  const auth = (req: any, reply: any) => app.authenticate(req, reply);

  // ─────────────────────────────────────────────
  // POST /api/chat/message
  // ─────────────────────────────────────────────
  app.post("/api/chat/message", { preHandler: [auth] }, async (req, reply) => {
    const bodyParsed = MessageBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: bodyParsed.error.message } });
    }
    const { text, source } = bodyParsed.data;
    const { sub: user_id } = req.user as { sub: string };

    const today = todayStr();
    const dateObj = toDateOnly(today);
    const messages: object[] = [];

    // 拉最近 4 条历史（最多 2 轮）作为上下文喂给 AI，规范 §6
    const recentRaw = await prisma.chatMessage.findMany({
      where: { user_id, date: dateObj },
      orderBy: { created_at: "desc" },
      take: 4,
      select: { role: true, content: true, kind: true },
    });
    const history = recentRaw
      .reverse()
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content ?? (m.kind !== "text" ? `[${m.kind}]` : ""),
      }))
      .filter((m) => m.content.length > 0);

    // 写用户气泡
    const userMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "user", kind: "text", content: text },
    });
    messages.push(userMsg);

    // 解析意图（flash → pro 若低置信）
    let parsed = await parseUserInput(text, history);
    if (parsed.intent === "record") {
      const hasLow = parsed.items.some((i) => i.food_confidence < 0.5);
      if (hasLow) {
        try {
          parsed = await parseUserInput(text, history, "deepseek-v4-pro");
        } catch {
          /* 保留 flash 结果 */
        }
      }
    }

    // 写解析日志
    await prisma.aiParseLog.create({
      data: {
        user_id,
        input_text: text,
        parsed_json: parsed as object,
        intent: parsed.intent,
        status: parsed.intent === "record" ? "auto" : "resolved",
      },
    });

    // ── query ──────────────────────────────────
    if (parsed.intent === "query") {
      const card = await buildContextCard(user_id);
      const aiText = await answerQuery(text, card);
      // 只有明确问今天的问题才展示 query_card 卡片；问历史的用纯文本气泡
      const isTodayQuery = /今天|今日|现在|还可以|剩余|还剩/.test(text);
      const aiMsg = await prisma.chatMessage.create({
        data: {
          user_id,
          date: dateObj,
          role: "assistant",
          kind: isTodayQuery ? "query_card" : "text",
          content: aiText,
          payload: isTodayQuery ? (card as object) : undefined,
        },
      });
      messages.push(aiMsg);
      return { intent: "query", reply: aiText, summary_card: card, messages };
    }

    // ── chat ───────────────────────────────────
    if (parsed.intent === "chat") {
      const aiText = await answerChat(text);
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: aiText },
      });
      messages.push(aiMsg);
      const card = await buildContextCard(user_id);
      return { intent: "chat", reply: aiText, summary_card: card, messages };
    }

    // ── record ─────────────────────────────────
    const user = await prisma.user.findUniqueOrThrow({ where: { id: user_id } });
    const weight_kg = Number(user.weight_kg) || 70;
    const meal_type = (parsed.meal_type ?? guessMealType()) as MealType;

    const records: object[] = [];
    let pending: object | null = null;
    const replyParts: string[] = [];
    let replyText: string;
    let needsRecompute = false;

    // 消息按优先级分两批：已确认先出，待确认后出
    const confirmedCreateFns: Array<() => Promise<any>> = [];
    const pendingCreateFns: Array<() => Promise<any>> = [];

    // 处理食物条目
    for (const item of parsed.items) {
      const { canonical, chosen_label, portions, food_confidence, portion_confidence, raw } = item;

      if (food_confidence >= 0.8 && portion_confidence >= 0.8) {
        // 高置信 → 自动入库
        const food = await matchFood(canonical);
        const chosenPortion = portions.find((p) => p.label === chosen_label) ?? portions[0];
        const weight_g = chosenPortion.grams;
        const nutrition = itemNutrition(food, weight_g);

        const record = await prisma.foodRecord.create({
          data: {
            user_id,
            food_id: food.id,
            meal_type,
            portion_label: chosen_label as PortionLabel,
            weight_g,
            calories: nutrition.calories,
            protein: nutrition.protein_g,
            fat: nutrition.fat_g,
            carbs: nutrition.carbs_g,
            food_confidence,
            portion_confidence,
            source,
            raw_input: raw,
            date: dateObj,
          },
        });
        needsRecompute = true;
        records.push(record);
        replyParts.push(`${food.name} ${weight_g}g（约 ${Math.round(nutrition.calories)} kcal）`);

        const recordData = {
          user_id,
          date: dateObj,
          role: "assistant" as const,
          kind: "record_card",
          payload: {
            food_name: food.name,
            weight_g,
            calories: Math.round(nutrition.calories),
            protein_g: Math.round(nutrition.protein_g),
            fat_g: Math.round(nutrition.fat_g),
            carbs_g: Math.round(nutrition.carbs_g),
            is_estimated: food.is_estimated,
          } as object,
          record_id: record.id as string,
        };
        confirmedCreateFns.push(() => prisma.chatMessage.create({ data: recordData }));

      } else if (food_confidence >= 0.8 && portion_confidence < 0.8) {
        // 食物确定，份量模糊 → 份量选择
        const food = await matchFood(canonical);
        const portionsWithCal = portions.map((p) => ({
          ...p,
          calories: p.grams > 0 ? Math.round(Number(food.calories_100g) * p.grams / 100) : undefined,
        }));
        const pr = await prisma.pendingRecord.create({
          data: {
            user_id,
            type: "portion_choice",
            raw_input: raw,
            candidates: {
              food_id: food.id,
              food_name: food.name,
              meal_type,
              source,
              portions,
            } as object,
          },
        });
        if (!pending) pending = pr;

        const portionData = {
          user_id,
          date: dateObj,
          role: "assistant" as const,
          kind: "portion_card",
          payload: { pending_id: pr.id, food_name: food.name, portions: portionsWithCal } as object,
        };
        pendingCreateFns.push(() => prisma.chatMessage.create({ data: portionData }));

      } else if (food_confidence >= 0.5) {
        // 食物模糊 → 先查候选；无候选时用 AI 估算并降级为份量卡
        const candidates = await matchFoodCandidates(canonical);

        if (candidates.length === 0) {
          // 数据库无匹配，AI 估算兜底，询问份量
          const food = await matchFood(canonical);
          const portionsWithCal = portions.map((p) => ({
            ...p,
            calories: p.grams > 0 ? Math.round(Number(food.calories_100g) * p.grams / 100) : undefined,
          }));
          const pr = await prisma.pendingRecord.create({
            data: {
              user_id,
              type: "portion_choice",
              raw_input: raw,
              candidates: {
                food_id: food.id,
                food_name: food.name,
                meal_type,
                source,
                portions,
              } as object,
            },
          });
          if (!pending) pending = pr;

          const portionData = {
            user_id,
            date: dateObj,
            role: "assistant" as const,
            kind: "portion_card",
            payload: { pending_id: pr.id, food_name: food.name, portions: portionsWithCal } as object,
          };
          pendingCreateFns.push(() => prisma.chatMessage.create({ data: portionData }));
        } else {
          const pr = await prisma.pendingRecord.create({
            data: {
              user_id,
              type: "food_choice",
              raw_input: raw,
              candidates: {
                query: canonical,
                meal_type,
                source,
                portions,
                chosen_label,
                foods: candidates.map((f) => ({ id: f.id, name: f.name, category: f.category })),
              } as object,
            },
          });
          if (!pending) pending = pr;

          const candidateData = {
            user_id,
            date: dateObj,
            role: "assistant" as const,
            kind: "candidate_card",
            payload: {
              pending_id: pr.id,
              query: canonical,
              foods: candidates.map((f) => ({ id: f.id, name: f.name, category: f.category })),
            } as object,
          };
          pendingCreateFns.push(() => prisma.chatMessage.create({ data: candidateData }));
        }

      } else {
        // 食物不明 → 追问
        const pr = await prisma.pendingRecord.create({
          data: {
            user_id,
            type: "clarify",
            raw_input: raw,
            candidates: { query: raw, meal_type, source, portions, chosen_label } as object,
          },
        });
        if (!pending) pending = pr;

        const clarifyData = {
          user_id,
          date: dateObj,
          role: "assistant" as const,
          kind: "clarify_card",
          payload: { pending_id: pr.id, query: raw, portions } as object,
        };
        pendingCreateFns.push(() => prisma.chatMessage.create({ data: clarifyData }));
      }
    }

    // 处理运动条目（运动视为已确认）
    for (const ex of (parsed.exercise ?? [])) {
      const duration_min = ex.duration_min ?? 30;
      const calories_burned = calcExerciseCalories(ex.type, duration_min, weight_kg);

      const exRecord = await prisma.exerciseRecord.create({
        data: {
          user_id,
          type: ex.type,
          duration_min,
          calories_burned,
          source,
          raw_input: text,
          date: dateObj,
        },
      });
      needsRecompute = true;
      replyParts.push(`运动 ${ex.type} ${duration_min}min（消耗约 ${calories_burned} kcal）`);

      const exData = {
        user_id,
        date: dateObj,
        role: "assistant" as const,
        kind: "exercise_card",
        payload: { exercise_id: exRecord.id, type: ex.type, duration_min, calories_burned } as object,
      };
      confirmedCreateFns.push(() => prisma.chatMessage.create({ data: exData }));
    }

    // 按优先级写入：已确认先，待确认后
    for (const fn of [...confirmedCreateFns, ...pendingCreateFns]) {
      const msg = await fn();
      messages.push(msg);
    }

    if (needsRecompute) await recompute(user_id, today);
    const summary_card = await buildContextCard(user_id);

    // 组织回复文本
    if (records.length > 0 && !pending) {
      replyText = `已记录：${replyParts.join("，")}。今日摄入 ${summary_card.today.in} kcal，还可吃 ${summary_card.today.remaining} kcal。`;
    } else if (records.length > 0) {
      replyText = `部分已记录：${replyParts.join("，")}，还有内容需要确认。`;
    } else if (pending) {
      replyText = "请帮我确认一下具体信息。";
    } else {
      replyText = "已记录。";
    }

    return {
      intent: "record",
      reply: replyText,
      record: records.length === 1 ? records[0] : records.length > 1 ? records[0] : undefined,
      records: records.length > 0 ? records : undefined,
      pending: pending ?? undefined,
      summary_card,
      messages,
    };
  });

  // ─────────────────────────────────────────────
  // POST /api/pending/:id/resolve
  // ─────────────────────────────────────────────
  app.post("/api/pending/:id/resolve", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const { id } = req.params as { id: string };

    const bodyParsed = ResolveBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: bodyParsed.error.message } });
    }
    const { choice } = bodyParsed.data;

    const pr = await prisma.pendingRecord.findFirst({
      where: { id, user_id, status: "pending" },
    });
    if (!pr) {
      return reply.status(404).send({ error: { code: "not_found", message: "Pending record not found or already resolved" } });
    }

    const candidates = pr.candidates as any;
    const today = todayStr();
    const dateObj = toDateOnly(today);
    const meal_type = (candidates.meal_type ?? guessMealType()) as MealType;
    const source: string = candidates.source ?? "text";

    let food_id: string;
    let weight_g: number;
    let portion_label: PortionLabel;

    if (pr.type === "portion_choice") {
      food_id = candidates.food_id as string;
      const portions: Array<{ label: string; grams: number }> = candidates.portions ?? [];

      if (typeof choice === "object" && "grams" in choice) {
        weight_g = choice.grams;
        portion_label = "custom";
      } else {
        const chosen = portions.find((p) => p.label === choice) ?? portions.find((p) => p.label === "medium") ?? portions[0];
        weight_g = chosen?.grams ?? 150;
        portion_label = (chosen?.label ?? "medium") as PortionLabel;
      }
    } else {
      // food_choice or clarify：choice 是 food_id（string）或自定义克数
      if (typeof choice === "object" && "grams" in choice) {
        // 自定义克数 + 第一个候选食物
        const foods: Array<{ id: string }> = candidates.foods ?? [];
        if (!foods.length) {
          return reply.status(400).send({ error: { code: "no_candidates", message: "No candidate foods available" } });
        }
        food_id = foods[0].id;
        weight_g = choice.grams;
        portion_label = "custom";
      } else {
        food_id = choice as string;
        const portions: Array<{ label: string; grams: number }> = candidates.portions ?? [];
        const chosen_label: string = candidates.chosen_label ?? "medium";
        const chosen = portions.find((p) => p.label === chosen_label) ?? portions.find((p) => p.label === "medium") ?? portions[0];
        weight_g = chosen?.grams ?? 150;
        portion_label = (chosen?.label ?? "medium") as PortionLabel;
      }
    }

    const food = await prisma.foodStandard.findUnique({ where: { id: food_id } });
    if (!food) {
      return reply.status(400).send({ error: { code: "invalid_food", message: "Food not found" } });
    }

    const nutrition = itemNutrition(food, weight_g);

    const record = await prisma.foodRecord.create({
      data: {
        user_id,
        food_id: food.id,
        meal_type,
        portion_label,
        weight_g,
        calories: nutrition.calories,
        protein: nutrition.protein_g,
        fat: nutrition.fat_g,
        carbs: nutrition.carbs_g,
        source,
        raw_input: pr.raw_input,
        date: dateObj,
      },
    });

    await prisma.pendingRecord.update({ where: { id }, data: { status: "resolved" } });

    await recompute(user_id, today);
    const summary_card = await buildContextCard(user_id);

    const aiMsg = await prisma.chatMessage.create({
      data: {
        user_id,
        date: dateObj,
        role: "assistant",
        kind: "record_card",
        content: `已确认：${food.name} ${weight_g}g（约 ${Math.round(nutrition.calories)} kcal）`,
        payload: {
          food_name: food.name,
          weight_g,
          calories: Math.round(nutrition.calories),
          protein_g: Math.round(nutrition.protein_g),
          fat_g: Math.round(nutrition.fat_g),
          carbs_g: Math.round(nutrition.carbs_g),
          is_estimated: food.is_estimated,
        } as object,
        record_id: record.id as string,
      },
    });

    return { record, summary_card, messages: [aiMsg] };
  });

  // ─────────────────────────────────────────────
  // GET /api/chat/messages?date=YYYY-MM-DD
  // ─────────────────────────────────────────────
  const DateQuerySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  });

  app.get("/api/chat/messages", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const qParsed = DateQuerySchema.safeParse(req.query);
    if (!qParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_params", message: qParsed.error.message } });
    }
    const { date } = qParsed.data;

    const messages = await prisma.chatMessage.findMany({
      where: { user_id, date: toDateOnly(date) },
      orderBy: { created_at: "asc" },
    });

    return { date, messages };
  });

  // ─────────────────────────────────────────────
  // GET /api/chat/dates?from=&to=
  // ─────────────────────────────────────────────
  const DatesQuerySchema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  });

  app.get("/api/chat/dates", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const qParsed = DatesQuerySchema.safeParse(req.query);
    if (!qParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_params", message: qParsed.error.message } });
    }
    const { from, to } = qParsed.data;

    const rows = await prisma.chatMessage.groupBy({
      by: ["date"],
      where: {
        user_id,
        date: { gte: toDateOnly(from), lte: toDateOnly(to) },
      },
      orderBy: { date: "asc" },
    });

    const dates = rows.map((r) => r.date.toISOString().slice(0, 10));
    return { dates };
  });
}
