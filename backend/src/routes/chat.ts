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
  // Use UTC+8 (Asia/Shanghai) local hour to avoid server UTC offset
  const h = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  if (h >= 5 && h < 10) return "breakfast";
  if (h >= 10 && h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  return "snack";
}

// 从原始文本中提取餐次，优先级高于 AI 结果和时间推断
function extractMealTypeFromText(text: string): MealType | null {
  if (/早上|早晨|早饭|早餐|上午/.test(text)) return "breakfast";
  if (/中午|午饭|午餐|中饭/.test(text)) return "lunch";
  if (/晚上|晚饭|晚餐|傍晚/.test(text)) return "dinner";
  if (/下午茶|下午|加餐|零食/.test(text)) return "snack";
  return null;
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
    z.string().min(1),                        // portion label ("small"/"medium"/"large") 或食物名
    z.object({ grams: z.number().positive() }), // 自定义克数（portion_card）
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

    // 写用户气泡
    const userMsg = await prisma.chatMessage.create({
      data: { user_id, date: dateObj, role: "user", kind: "text", content: text },
    });
    messages.push(userMsg);

    // 解析意图（flash → pro 若低置信）；不携带历史，每条消息独立解析避免 AI 误判为补充
    let parsed = await parseUserInput(text);
    if (parsed.intent === "record") {
      const hasLow = parsed.items.some((i) => i.food_confidence < 0.5);
      if (hasLow) {
        try {
          parsed = await parseUserInput(text, [], "deepseek-v4-pro");
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
    const meal_type = (extractMealTypeFromText(text) ?? parsed.meal_type ?? guessMealType()) as MealType;

    const records: object[] = [];
    let pending: object | null = null;
    const replyParts: string[] = [];
    let replyText: string;
    let needsRecompute = false;

    // 消息按优先级分两批：已确认先出，待确认后出
    const confirmedCreateFns: Array<() => Promise<any>> = [];
    const pendingCreateFns: Array<() => Promise<any>> = [];

    // 处理食物条目
    // 歧义判定双信号：AI is_ambiguous OR DB calorie_spread > 100 kcal/100g
    // 任一为真 → CandidateCard（选种类）→ resolve 后生成 PortionCard（两步走）
    // 两者均假 → matchFood 最佳单一匹配 → 视 portion_confidence 自动录或 PortionCard
    const FOOD_AMBIGUITY_SPREAD = 100; // kcal/100g 离散度阈值

    for (const item of parsed.items) {
      const { canonical, chosen_label, portions, food_confidence, portion_confidence, raw, is_ambiguous, ai_candidates } = item;
      const query = canonical || raw;

      const { foods: dbCandidates, calorie_spread } = await matchFoodCandidates(query);

      // DB 离散度仅在 AI 自身对食物不确定时作为补充信号（高置信时信任 AI 判断）
      const isAmbiguous = is_ambiguous ||
        (food_confidence < 0.85 && dbCandidates.length >= 2 && calorie_spread > FOOD_AMBIGUITY_SPREAD);

      if (isAmbiguous) {
        // 歧义 → 合并 DB 候选 + AI 建议候选，带热量提示，两步走
        const mediumGrams = (portions.find((p) => p.label === "medium") ?? portions[0])?.grams ?? 150;

        // 以 DB 候选为主，补充 AI 候选名（去重）
        const dbNames = new Set(dbCandidates.map((f) => f.name));
        const aiNames: string[] = (ai_candidates ?? []).filter((n) => !dbNames.has(n));
        const allNames = [...dbCandidates.map((f) => f.name), ...aiNames].slice(0, 3);

        // 构建带热量提示的候选列表（DB 有记录则能算，AI 补充的暂不算）
        const foodsPayload = allNames.map((name) => {
          const dbEntry = dbCandidates.find((f) => f.name === name);
          return {
            name,
            calorie_hint: dbEntry
              ? Math.round(Number(dbEntry.calories_100g) * mediumGrams / 100)
              : undefined,
          };
        });

        const pr = await prisma.pendingRecord.create({
          data: {
            user_id,
            type: "food_choice",
            raw_input: raw,
            candidates: {
              query,
              meal_type,
              source,
              portions,   // 保留原始份量估算，resolve 时用所选食物重算热量
              chosen_label,
            } as object,
          },
        });
        if (!pending) pending = pr;

        pendingCreateFns.push(() => prisma.chatMessage.create({
          data: {
            user_id,
            date: dateObj,
            role: "assistant" as const,
            kind: "candidate_card",
            payload: { pending_id: pr.id, query, foods: foodsPayload } as object,
          },
        }));

      } else {
        // 食物明确（或无候选走 AI 估算）→ matchFood 取最佳单一匹配（含 AI 估算兜底）
        const food = await matchFood(query);

        if (food_confidence >= 0.8 && portion_confidence >= 0.8) {
          // 高置信 → 自动入库
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

          confirmedCreateFns.push(() => prisma.chatMessage.create({
            data: {
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
            },
          }));

        } else {
          // 食物唯一但份量不明（或食物置信度低）→ 询问份量
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

          pendingCreateFns.push(() => prisma.chatMessage.create({
            data: {
              user_id,
              date: dateObj,
              role: "assistant" as const,
              kind: "portion_card",
              payload: { pending_id: pr.id, food_name: food.name, portions: portionsWithCal } as object,
            },
          }));
        }
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
      // food_choice：choice 是食物名（string），用 matchFood 查找/估算
      // 不直接落库，而是生成 portion_choice pending → 返回 PortionCard（两步走）
      const foodName = choice as string;
      const food = await matchFood(foodName);

      const portionsList: Array<{ label: string; grams: number }> = candidates.portions ?? [];
      const portionsWithCal = portionsList.map((p) => ({
        ...p,
        calories: p.grams > 0 ? Math.round(Number(food.calories_100g) * p.grams / 100) : undefined,
      }));

      const newPr = await prisma.pendingRecord.create({
        data: {
          user_id,
          type: "portion_choice",
          raw_input: pr.raw_input,
          candidates: {
            food_id: food.id,
            food_name: food.name,
            meal_type,
            source,
            portions: portionsWithCal,
          } as object,
        },
      });

      await prisma.pendingRecord.update({ where: { id }, data: { status: "resolved" } });

      const portionCardMsg = await prisma.chatMessage.create({
        data: {
          user_id,
          date: dateObj,
          role: "assistant",
          kind: "portion_card",
          payload: {
            pending_id: newPr.id,
            food_name: food.name,
            portions: portionsWithCal,
          } as object,
        },
      });

      const summary_card = await buildContextCard(user_id);
      return { summary_card, messages: [portionCardMsg] };
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

    // 收集所有 pending_id，查哪些已 resolved，前端据此渲染卡片状态
    const pendingIds = messages
      .filter((m) => ["portion_card", "candidate_card", "clarify_card"].includes(m.kind))
      .map((m) => (m.payload as any)?.pending_id as string | undefined)
      .filter(Boolean) as string[];

    let resolved_pending_ids: string[] = [];
    if (pendingIds.length > 0) {
      const resolved = await prisma.pendingRecord.findMany({
        where: { id: { in: pendingIds }, status: "resolved" },
        select: { id: true },
      });
      resolved_pending_ids = resolved.map((r) => r.id);
    }

    return { date, messages, resolved_pending_ids };
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
