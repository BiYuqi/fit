import { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseUserInput } from "../services/parser";
import { matchFood, matchFoodCandidates } from "../services/matcher";
import { itemNutrition } from "../services/calc";
import { recompute, buildContextCard } from "../services/summary";
import { buildMemoryPack } from "../services/memory";
import type { MemoryPack } from "../services/memory";
import type { FoodItem } from "../ai/schema";
import { callDeepSeekCtx } from "../ai/ctx";
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

async function answerQuery(question: string, pack: MemoryPack): Promise<string> {
  const res = await callDeepSeekCtx(
    pack,
    [
      {
        role: "system",
        content: "你是减脂助手，根据用户今日数据回答问题，数字来自上下文，回答简洁中文。",
      },
      { role: "user", content: question },
    ],
    { model: "deepseek-v4-flash" },
  );
  return res.choices[0]?.message?.content ?? "暂时无法回答";
}

async function answerChat(text: string, pack: MemoryPack): Promise<string> {
  const res = await callDeepSeekCtx(
    pack,
    [
      {
        role: "system",
        content: `你是一个减脂健康助手，根据上下文（用户档案/今日记录/对话历史）回答问题，回答简洁，使用中文。
只回答与饮食、营养、运动、减脂、体重管理相关的问题。
如果用户的问题与以上主题完全无关（如编程、娱乐、时事等），请礼貌拒绝，回复：「这个问题超出我的服务范围啦～我只能帮你解答饮食、营养和运动相关的问题，有减脂方面的疑问随时告诉我 💪」`,
      },
      { role: "user", content: text },
    ],
    { model: "deepseek-v4-flash" },
  );
  return res.choices[0]?.message?.content ?? "好的";
}

async function answerDiscuss(
  question: string,
  target: import("../services/memory").RecordRef,
  fullRecord: { portion_label: string; food_confidence: number; portion_confidence: number; raw_input: string | null; food: { name: string; calories_100g: unknown } | null } | null,
  pack: MemoryPack,
): Promise<string> {
  const PORTION_ZH: Record<string, string> = { small: "小份", medium: "中份", large: "大份", custom: "自定" };
  let detail = `【被询问的记录】\n- 食物：${target.name}\n- 克数：${target.weight_g}g（${PORTION_ZH[target.portion ?? ""] ?? target.portion ?? "?"}份）\n- 热量：${target.calories}kcal`;
  if (fullRecord) {
    if (fullRecord.raw_input) detail += `\n- 用户原话："${fullRecord.raw_input}"`;
    detail += `\n- AI置信度：食物 ${fullRecord.food_confidence?.toFixed(2)}，份量 ${fullRecord.portion_confidence?.toFixed(2)}`;
    if (fullRecord.food) {
      detail += `\n- 食物库：${fullRecord.food.name} 每100g ${Math.round(Number(fullRecord.food.calories_100g))}kcal`;
    }
  }
  const res = await callDeepSeekCtx(
    pack,
    [
      {
        role: "system",
        content: `你是减脂助手。用户对某条饮食记录提出了疑问，请结合以下记录详情，简洁中文解释这条记录是如何产生的（份量估算依据、克数来源、热量算法）。若用户觉得克数不准，告知可以说"改成X克"来调整。\n\n${detail}`,
      },
      { role: "user", content: question },
    ],
    { model: "deepseek-v4-flash" },
  );
  return res.choices[0]?.message?.content ?? "我来解释一下这条记录的来由…";
}

// ---------- 单条食物处理（record 与 modify.append 共用） ----------
// 歧义判定双信号：AI is_ambiguous OR DB calorie_spread > 100 kcal/100g
const FOOD_AMBIGUITY_SPREAD = 100; // kcal/100g 离散度阈值

interface ItemCtx {
  user_id: string;
  meal_type: MealType;
  source: string;
  dateObj: Date;
  withUndo: boolean; // append 时记录卡带 undo
}

interface ItemResult {
  record?: any;
  replyPart?: string;
  needsRecompute: boolean;
  pending?: any;
  confirmedFn?: () => Promise<any>;
  pendingFn?: () => Promise<any>;
}

async function processFoodItem(item: FoodItem, ctx: ItemCtx): Promise<ItemResult> {
  const { user_id, meal_type, source, dateObj, withUndo } = ctx;
  const { canonical, chosen_label, portions, food_confidence, portion_confidence, raw, is_ambiguous, ai_candidates } = item;
  const query = canonical || raw;

  const { foods: dbCandidates, calorie_spread } = await matchFoodCandidates(query);

  const isAmbiguous =
    is_ambiguous ||
    (food_confidence < 0.85 && dbCandidates.length >= 2 && calorie_spread > FOOD_AMBIGUITY_SPREAD);

  if (isAmbiguous) {
    const mediumGrams = (portions.find((p) => p.label === "medium") ?? portions[0])?.grams ?? 150;
    const dbNames = new Set(dbCandidates.map((f) => f.name));
    const aiNames: string[] = (ai_candidates ?? []).filter((n) => !dbNames.has(n));
    const allNames = [...dbCandidates.map((f) => f.name), ...aiNames].slice(0, 3);
    const foodsPayload = allNames.map((name) => {
      const dbEntry = dbCandidates.find((f) => f.name === name);
      return {
        name,
        calorie_hint: dbEntry ? Math.round(Number(dbEntry.calories_100g) * mediumGrams / 100) : undefined,
      };
    });

    const pr = await prisma.pendingRecord.create({
      data: {
        user_id,
        type: "food_choice",
        raw_input: raw,
        candidates: { query, meal_type, source, portions, chosen_label } as object,
      },
    });

    return {
      needsRecompute: false,
      pending: pr,
      pendingFn: () => prisma.chatMessage.create({
        data: {
          user_id, date: dateObj, role: "assistant", kind: "candidate_card",
          payload: { pending_id: pr.id, query, foods: foodsPayload } as object,
        },
      }),
    };
  }

  const food = await matchFood(query, raw);

  if (food_confidence >= 0.8 && portion_confidence >= 0.8) {
    const chosenPortion = portions.find((p) => p.label === chosen_label) ?? portions[0];
    const weight_g = chosenPortion.grams;
    const nutrition = itemNutrition(food, weight_g);

    const record = await prisma.foodRecord.create({
      data: {
        user_id, food_id: food.id, meal_type, portion_label: chosen_label as PortionLabel,
        weight_g, calories: nutrition.calories, protein: nutrition.protein_g,
        fat: nutrition.fat_g, carbs: nutrition.carbs_g,
        food_confidence, portion_confidence, source, raw_input: raw, date: dateObj,
      },
    });

    const payload: any = {
      food_name: food.name, weight_g, calories: Math.round(nutrition.calories),
      protein_g: Math.round(nutrition.protein_g), fat_g: Math.round(nutrition.fat_g),
      carbs_g: Math.round(nutrition.carbs_g), is_estimated: food.is_estimated,
    };
    if (withUndo) payload.undo = { record_id: record.id }; // append 撤销=删新记录

    return {
      record,
      replyPart: `${food.name} ${weight_g}g（约 ${Math.round(nutrition.calories)} kcal）`,
      needsRecompute: true,
      confirmedFn: () => prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "record_card", payload, record_id: record.id as string },
      }),
    };
  }

  // 食物唯一但份量不明 → 询问份量
  const portionsWithCal = portions.map((p) => ({
    ...p,
    calories: p.grams > 0 ? Math.round(Number(food.calories_100g) * p.grams / 100) : undefined,
  }));
  const pr = await prisma.pendingRecord.create({
    data: {
      user_id, type: "portion_choice", raw_input: raw,
      candidates: { food_id: food.id, food_name: food.name, meal_type, source, portions } as object,
    },
  });

  return {
    needsRecompute: false,
    pending: pr,
    pendingFn: () => prisma.chatMessage.create({
      data: {
        user_id, date: dateObj, role: "assistant", kind: "portion_card",
        payload: { pending_id: pr.id, food_name: food.name, portions: portionsWithCal } as object,
      },
    }),
  };
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

    // 组装对话记忆包（L0 ai_parse_log / L1 今日记录 / L2 画像+卡），注入 prompt 消解指代
    // 此刻本条消息尚未写 ai_parse_log / food_record，记忆包反映的是「本条之前」状态，正合语义
    const pack = await buildMemoryPack(user_id);

    // 解析意图（flash → pro 若低置信）
    let parsed = await parseUserInput(text, pack);
    if (parsed.intent === "record") {
      const hasLow = parsed.items.some((i) => i.food_confidence < 0.5);
      if (hasLow) {
        try {
          parsed = await parseUserInput(text, pack, "deepseek-v4-pro");
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
      const aiText = await answerQuery(text, pack);
      // 只有明确问今天的问题才展示 query_card 卡片；问历史的用纯文本气泡
      const isTodayQuery = /今天|今日|现在|还可以|剩余|还剩/.test(text);
      const aiMsg = await prisma.chatMessage.create({
        data: {
          user_id,
          date: dateObj,
          role: "assistant",
          kind: isTodayQuery ? "query_card" : "text",
          content: aiText,
          payload: isTodayQuery ? (pack.card as object) : undefined,
        },
      });
      messages.push(aiMsg);
      return { intent: "query", reply: aiText, summary_card: pack.card, messages };
    }

    // ── chat ───────────────────────────────────
    if (parsed.intent === "chat") {
      const aiText = await answerChat(text, pack);
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: aiText },
      });
      messages.push(aiMsg);
      return { intent: "chat", reply: aiText, summary_card: pack.card, messages };
    }

    // ── discuss（针对某条记录提问/质疑，不动数据）─────
    if (parsed.intent === "discuss") {
      const discParsed = parsed as { intent: "discuss"; target: string };
      const target = pack.recent_records.find((r) => r.ref === discParsed.target);
      let aiText: string;
      if (!target) {
        // 找不到目标记录，退化为 chat
        aiText = await answerChat(text, pack);
      } else {
        const fullRecord = target.kind === "food"
          ? await prisma.foodRecord.findFirst({
              where: { id: target.record_id, user_id },
              include: { food: true },
            })
          : null;
        aiText = await answerDiscuss(text, target, fullRecord as any, pack);
      }
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: aiText },
      });
      messages.push(aiMsg);
      return { intent: "discuss", reply: aiText, summary_card: pack.card, messages };
    }

    // ── modify（改 / 删 / 追加，AI_PARSING_SPEC §8）──
    if (parsed.intent === "modify") {
      const target = pack.recent_records.find((r) => r.ref === parsed.target);
      if (!target) {
        const aiMsg = await prisma.chatMessage.create({
          data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "没找到要修改的那条记录，可以说得具体一点吗？" },
        });
        messages.push(aiMsg);
        const card = await buildContextCard(user_id);
        return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
      }

      // delete → 确认卡（破坏性，需确认）
      if (parsed.action === "delete") {
        const pr = await prisma.pendingRecord.create({
          data: {
            user_id, type: "delete_confirm", raw_input: text,
            candidates: { record_id: target.record_id, kind: target.kind, name: target.name } as object,
          },
        });
        const aiMsg = await prisma.chatMessage.create({
          data: {
            user_id, date: dateObj, role: "assistant", kind: "delete_confirm_card",
            payload: { pending_id: pr.id, record_id: target.record_id, name: target.name, meal_type: target.meal_type, calories: target.calories } as object,
          },
        });
        messages.push(aiMsg);
        const card = await buildContextCard(user_id);
        return { intent: "modify", reply: `确认删除「${target.name}」吗？`, pending: pr, summary_card: card, messages };
      }

      // append → 在 target 所属餐追加新食物（继承 meal_type），高置信直入库 + 撤销
      if (parsed.action === "append") {
        const meal_type = (target.meal_type ?? guessMealType()) as MealType;
        const records: object[] = [];
        const replyParts: string[] = [];
        let pending: object | null = null;
        let needsRecompute = false;
        const confirmedCreateFns: Array<() => Promise<any>> = [];
        const pendingCreateFns: Array<() => Promise<any>> = [];

        for (const item of (parsed.items ?? [])) {
          const r = await processFoodItem(item, { user_id, meal_type, source, dateObj, withUndo: true });
          if (r.record) records.push(r.record);
          if (r.replyPart) replyParts.push(r.replyPart);
          if (r.needsRecompute) needsRecompute = true;
          if (r.pending && !pending) pending = r.pending;
          if (r.confirmedFn) confirmedCreateFns.push(r.confirmedFn);
          if (r.pendingFn) pendingCreateFns.push(r.pendingFn);
        }
        for (const fn of [...confirmedCreateFns, ...pendingCreateFns]) messages.push(await fn());
        if (needsRecompute) await recompute(user_id, today);
        const card = await buildContextCard(user_id);
        const reply = records.length > 0
          ? `已追加：${replyParts.join("，")}。`
          : pending ? "请帮我确认追加内容。" : "好的。";
        return { intent: "modify", reply, records: records.length ? records : undefined, pending: pending ?? undefined, summary_card: card, messages };
      }

      // update → 改份量 / 改食物，高置信直改 + 重算 + 撤销
      if (target.kind !== "food") {
        const aiMsg = await prisma.chatMessage.create({
          data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "目前只支持修改饮食记录哦。" },
        });
        messages.push(aiMsg);
        const card = await buildContextCard(user_id);
        return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
      }
      const rec = await prisma.foodRecord.findFirst({ where: { id: target.record_id, user_id } });
      if (!rec) {
        const aiMsg = await prisma.chatMessage.create({
          data: { user_id, date: dateObj, role: "assistant", kind: "text", content: "这条记录好像已经不在了。" },
        });
        messages.push(aiMsg);
        const card = await buildContextCard(user_id);
        return { intent: "modify", reply: aiMsg.content, summary_card: card, messages };
      }

      const prev_state = { food_id: rec.food_id, portion_label: rec.portion_label, weight_g: rec.weight_g };
      const change = parsed.change ?? {};
      let food = await prisma.foodStandard.findUniqueOrThrow({ where: { id: rec.food_id } });
      let weight_g = rec.weight_g;
      let portion_label = rec.portion_label as PortionLabel;

      if (change.food) {
        food = await matchFood(change.food);   // 改食物：份量沿用旧的
      }
      if (change.portion_label) {
        portion_label = change.portion_label as PortionLabel;
        if (change.grams) weight_g = change.grams;
      } else if (change.grams) {
        weight_g = change.grams;
        portion_label = "custom";
      }

      const nutrition = itemNutrition(food, weight_g);
      const updated = await prisma.foodRecord.update({
        where: { id: rec.id },
        data: {
          food_id: food.id, portion_label, weight_g,
          calories: nutrition.calories, protein: nutrition.protein_g,
          fat: nutrition.fat_g, carbs: nutrition.carbs_g,
        },
      });
      await recompute(user_id, today);
      const card = await buildContextCard(user_id);
      const content = `已更新：${food.name} ${Math.round(weight_g)}g（约 ${Math.round(nutrition.calories)} kcal）`;
      const aiMsg = await prisma.chatMessage.create({
        data: {
          user_id, date: dateObj, role: "assistant", kind: "record_card", content,
          payload: {
            food_name: food.name, weight_g: Math.round(weight_g), calories: Math.round(nutrition.calories),
            protein_g: Math.round(nutrition.protein_g), fat_g: Math.round(nutrition.fat_g),
            carbs_g: Math.round(nutrition.carbs_g), is_estimated: food.is_estimated,
            undo: { record_id: updated.id, prev_state }, // 撤销=还原 prev_state
          } as object,
          record_id: updated.id as string,
        },
      });
      messages.push(aiMsg);
      return { intent: "modify", reply: content, record: updated, summary_card: card, messages };
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

    // 处理食物条目（逐条走共用 helper：歧义→候选卡 / 份量不明→份量卡 / 高置信→自动入库）
    for (const item of parsed.items) {
      const r = await processFoodItem(item, { user_id, meal_type, source, dateObj, withUndo: false });
      if (r.record) records.push(r.record);
      if (r.replyPart) replyParts.push(r.replyPart);
      if (r.needsRecompute) needsRecompute = true;
      if (r.pending && !pending) pending = r.pending;
      if (r.confirmedFn) confirmedCreateFns.push(r.confirmedFn);
      if (r.pendingFn) pendingCreateFns.push(r.pendingFn);
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

    // delete_confirm：用户点了确认 → 删记录（AI_PARSING_SPEC §8）
    if (pr.type === "delete_confirm") {
      if (candidates.kind === "exercise") {
        await prisma.exerciseRecord.deleteMany({ where: { id: candidates.record_id, user_id } });
      } else {
        await prisma.foodRecord.deleteMany({ where: { id: candidates.record_id, user_id } });
      }
      await prisma.pendingRecord.update({ where: { id }, data: { status: "resolved" } });
      await recompute(user_id, today);
      const summary_card = await buildContextCard(user_id);
      const aiMsg = await prisma.chatMessage.create({
        data: { user_id, date: dateObj, role: "assistant", kind: "text", content: `已删除：${candidates.name}` },
      });
      return { summary_card, messages: [aiMsg] };
    }

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
  // POST /api/records/:id/undo  —— 撤销 modify 的 update/append（AI_PARSING_SPEC §8）
  // 带 prev_state → 还原（update 撤销）；不带 → 删记录（append 撤销）
  // ─────────────────────────────────────────────
  const UndoBodySchema = z.object({
    prev_state: z.object({
      food_id: z.string(),
      portion_label: z.enum(["small", "medium", "large", "custom"]),
      weight_g: z.number().positive(),
    }).optional(),
  });

  app.post("/api/records/:id/undo", { preHandler: [auth] }, async (req, reply) => {
    const { sub: user_id } = req.user as { sub: string };
    const { id } = req.params as { id: string };
    const bodyParsed = UndoBodySchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      return reply.status(400).send({ error: { code: "invalid_input", message: bodyParsed.error.message } });
    }

    const rec = await prisma.foodRecord.findFirst({ where: { id, user_id } });
    if (!rec) {
      return reply.status(404).send({ error: { code: "not_found", message: "Record not found" } });
    }
    const recDate = rec.date.toISOString().slice(0, 10);

    const prev = bodyParsed.data.prev_state;
    if (prev) {
      // update 撤销 → 还原食物/份量/克数并重算
      const food = await prisma.foodStandard.findUnique({ where: { id: prev.food_id } });
      if (!food) {
        return reply.status(400).send({ error: { code: "invalid_food", message: "Previous food not found" } });
      }
      const nutrition = itemNutrition(food, prev.weight_g);
      await prisma.foodRecord.update({
        where: { id },
        data: {
          food_id: prev.food_id, portion_label: prev.portion_label as PortionLabel, weight_g: prev.weight_g,
          calories: nutrition.calories, protein: nutrition.protein_g, fat: nutrition.fat_g, carbs: nutrition.carbs_g,
        },
      });
    } else {
      // append 撤销 → 删新记录
      await prisma.foodRecord.delete({ where: { id } });
    }

    await recompute(user_id, recDate);
    const summary_card = await buildContextCard(user_id);
    return { ok: true, summary_card };
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
      .filter((m) => ["portion_card", "candidate_card", "clarify_card", "delete_confirm_card"].includes(m.kind))
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
