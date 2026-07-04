// T46 餐食卡：按 (用户, 日期, 餐次) 一餐一卡 + 实时组装 + 卡片跟随。
// 落库 payload 只存组装键 meal_key（铁律 2/3：事实源是 food_record，卡片纯展示），
// 明细 items 与营养 totals 在响应/GET 时从 food_record 实时组装，组装结果不落库、永不过期。
// 内容变更时同一条消息 created_at 刷新（bump），前端按时间重排后卡片"浮"到聊天流末尾。
import { prisma } from "../lib/prisma";
import { toDateOnly } from "../lib/dates";
import type { MealType } from "@prisma/client";

// 最小 db 接口：生产默认 prisma，单测注入 fake（幂等/求和逻辑不依赖真库）
export type MealCardDb = {
  chatMessage: {
    findFirst: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  foodRecord: {
    findMany: (args: any) => Promise<any[]>;
  };
};

// 组装所需的 food_record 最小结构（结构化类型，单测无需 Prisma 生成类型）
export interface MealCardRecord {
  id: string;
  raw_input: string | null;
  weight_g: number;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  portion_label: string;
  food: { name: string; is_estimated: boolean };
}

export interface MealCardView {
  items: Array<{
    record_id: string;
    food_name: string;
    raw_input: string | null; // 明细主显示：用户原话子句（自然单位天然保留），food_name+weight_g 作兜底
    weight_g: number;
    calories: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
    is_estimated: boolean;
    portion_label: string;
  }>;
  totals: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  item_count: number;
}

// 纯组装：food_record[] → 卡片视图。totals 对取整后的 items 求和，保证卡内明细与总计自洽（铁律 1：后端算账）。
export function buildMealCardView(records: MealCardRecord[]): MealCardView {
  const items = records.map((r) => ({
    record_id: r.id,
    food_name: r.food.name,
    raw_input: r.raw_input ?? null,
    weight_g: Math.round(r.weight_g),
    calories: Math.round(r.calories),
    protein_g: Math.round(r.protein),
    fat_g: Math.round(r.fat),
    carbs_g: Math.round(r.carbs),
    is_estimated: r.food.is_estimated,
    portion_label: r.portion_label,
  }));
  const totals = items.reduce(
    (acc, it) => ({
      calories: acc.calories + it.calories,
      protein_g: acc.protein_g + it.protein_g,
      fat_g: acc.fat_g + it.fat_g,
      carbs_g: acc.carbs_g + it.carbs_g,
    }),
    { calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
  );
  return { items, totals, item_count: items.length };
}

// 幂等 upsert：该餐已有 meal_card 则只刷新 created_at（bump），没有则创建。
// mealDate 是餐归属日（YYYY-MM-DD），与 chat_message.date（对话日 chatDate）独立存——跨天修改时二者可不同。
// isFirst：本次创建是否该用户第一张 meal_card（record 回复文本追加一次性引导提示用）。
export async function upsertMealCardMessage(
  params: { user_id: string; mealDate: string; meal_type: MealType; chatDate: Date },
  db: MealCardDb = prisma,
): Promise<{ message: any; isFirst: boolean }> {
  const { user_id, mealDate, meal_type, chatDate } = params;

  const existing = await db.chatMessage.findFirst({
    where: {
      user_id,
      kind: "meal_card",
      AND: [
        { payload: { path: ["meal_key", "date"], equals: mealDate } },
        { payload: { path: ["meal_key", "meal_type"], equals: meal_type } },
      ],
    },
  });
  if (existing) {
    const message = await db.chatMessage.update({
      where: { id: existing.id },
      data: { created_at: new Date() },
    });
    return { message, isFirst: false };
  }

  const hasAny = await db.chatMessage.findFirst({
    where: { user_id, kind: "meal_card" },
    select: { id: true },
  });
  const message = await db.chatMessage.create({
    data: {
      user_id,
      date: chatDate,
      role: "assistant",
      kind: "meal_card",
      // last_change 本任务恒 null，T47 启用（modify 撤销信息）
      payload: { meal_key: { date: mealDate, meal_type }, last_change: null } as object,
    },
  });
  return { message, isFirst: !hasAny };
}

// 批量实时组装：把消息数组里 meal_card 的返回态 payload 补上 items/totals/item_count。
// 全删光的餐返回 items: []（前端渲染"已清空"态）。非 meal_card 消息原样透传。
export async function enrichMealCards<
  T extends { kind: string; user_id: string; payload: unknown },
>(messages: T[], db: MealCardDb = prisma): Promise<T[]> {
  const keys = new Map<string, { user_id: string; date: string; meal_type: string }>();
  for (const m of messages) {
    if (m.kind !== "meal_card") continue;
    const mk = (m.payload as any)?.meal_key;
    if (!mk?.date || !mk?.meal_type) continue;
    keys.set(`${m.user_id}|${mk.date}|${mk.meal_type}`, {
      user_id: m.user_id,
      date: mk.date,
      meal_type: mk.meal_type,
    });
  }
  if (keys.size === 0) return messages;

  const views = new Map<string, MealCardView>();
  for (const [key, k] of keys) {
    const records = await db.foodRecord.findMany({
      where: { user_id: k.user_id, date: toDateOnly(k.date), meal_type: k.meal_type as MealType },
      include: { food: true },
      orderBy: { created_at: "asc" },
    });
    views.set(key, buildMealCardView(records as MealCardRecord[]));
  }

  return messages.map((m) => {
    if (m.kind !== "meal_card") return m;
    const mk = (m.payload as any)?.meal_key;
    const view = mk ? views.get(`${m.user_id}|${mk.date}|${mk.meal_type}`) : undefined;
    if (!view) return m;
    return { ...m, payload: { ...(m.payload as any), ...view } };
  });
}
