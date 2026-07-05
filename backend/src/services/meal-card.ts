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
  count: number | null;
  count_unit: string | null;
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
    food_name: string; // 明细主显示：有 count 时前端拼 `食物名 ×count`，否则 `食物名 weight_g`（T52）
    count: number | null; // 可数份数，展示用不算账（铁律 1）；null=纯重量/旧记录，退回克数显示
    count_unit: string | null;
    raw_input: string | null; // 数据留痕，不再作主显示（T52 前曾为主显示）
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
    count: r.count ?? null,
    count_unit: r.count != null ? (r.count_unit ?? null) : null,
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

// 撤销信息（T47/T53）：一条记录的撤销态。prev_state 有 = update 撤销（还原），无 = append 撤销（删除）。
export type MealCardLastChange = { record_id: string; prev_state?: Record<string, unknown> };

// T53：撤销态从单槽 last_change 升级为按 record_id 存多条 last_changes——一轮 multi 批量改 N 条，
// N 条各自独立可撤销、互不覆盖。写入用指令式：set 按 record_id 合并/替换该条、clear 只删该条，其余保留。
export type LastChangeInstr =
  | { op: "set"; change: MealCardLastChange }
  | { op: "clear"; record_id: string };

// 读现有撤销态：新 payload 用 last_changes 数组；旧 payload（T53 前）单槽 last_change 兼容包成单元素数组。
export function readLastChanges(payload: unknown): MealCardLastChange[] {
  const p = payload as any;
  if (Array.isArray(p?.last_changes)) return p.last_changes as MealCardLastChange[];
  if (p?.last_change) return [p.last_change as MealCardLastChange];
  return [];
}

function applyLastChange(existing: MealCardLastChange[], instr: LastChangeInstr): MealCardLastChange[] {
  if (instr.op === "clear") return existing.filter((c) => c.record_id !== instr.record_id);
  // set：同 record_id 的旧撤销态被本次覆盖（一条记录只留最近一次修改的还原点），其余不动
  return [...existing.filter((c) => c.record_id !== instr.change.record_id), instr.change];
}

export interface UpsertMealCardParams {
  user_id: string;
  mealDate: string; // 餐归属日（YYYY-MM-DD），与 chat_message.date（对话日 chatDate）独立——跨天修改时二者可不同
  meal_type: MealType;
  chatDate: Date;
  // undefined = 不动现有撤销态；set/clear 指令 = 按 record_id 增量更新 last_changes（见 LastChangeInstr）
  lastChange?: LastChangeInstr;
  // false：只 bump 已存在的卡，不存在则返回 null——用于"变少"侧刷新（删除/撤销/改餐次的旧餐卡），
  // 避免给从没有过卡的餐（pre-T46 记录）凭空造出一张卡
  createIfMissing?: boolean;
}

// 幂等 upsert：该餐已有 meal_card 则刷新 created_at（bump，卡片跟随）+ 按 lastChange 指令增量更新 last_changes；没有则创建。
// isFirst：本次创建是否该用户第一张 meal_card（record 回复文本追加一次性引导提示用）。
export async function upsertMealCardMessage(
  params: UpsertMealCardParams,
  db: MealCardDb = prisma,
): Promise<{ message: any; isFirst: boolean } | null> {
  const { user_id, mealDate, meal_type, chatDate, lastChange, createIfMissing = true } = params;

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
    const data: Record<string, unknown> = { created_at: new Date() };
    if (lastChange !== undefined) {
      const nextChanges = applyLastChange(readLastChanges(existing.payload), lastChange);
      const { last_change: _legacy, ...rest } = (existing.payload as any) ?? {}; // 抹掉旧单槽键
      data.payload = { ...rest, last_changes: nextChanges };
    }
    const message = await db.chatMessage.update({ where: { id: existing.id }, data });
    return { message, isFirst: false };
  }

  if (!createIfMissing) return null;

  const hasAny = await db.chatMessage.findFirst({
    where: { user_id, kind: "meal_card" },
    select: { id: true },
  });
  const initChanges = lastChange?.op === "set" ? [lastChange.change] : [];
  const message = await db.chatMessage.create({
    data: {
      user_id,
      date: chatDate,
      role: "assistant",
      kind: "meal_card",
      payload: { meal_key: { date: mealDate, meal_type }, last_changes: initChanges } as object,
    },
  });
  return { message, isFirst: !hasAny };
}

// upsert + 实时组装 + 去重放入 messages（本轮响应里同一张卡只留最新组装态——multi 多 op 触同一餐时）。
// 所有写路径（record/modify/resolve/undo）统一走这里，保证卡片排在本轮已有消息之后（卡片跟随）。
export async function refreshMealCard(
  messages: object[],
  params: UpsertMealCardParams,
  db: MealCardDb = prisma,
): Promise<{ message: any; isFirst: boolean } | null> {
  const upserted = await upsertMealCardMessage(params, db);
  if (!upserted) return null;
  const [enriched] = await enrichMealCards([upserted.message], db);
  const dup = messages.findIndex((m) => (m as any).id === upserted.message.id);
  if (dup >= 0) messages.splice(dup, 1);
  messages.push(enriched);
  return { message: enriched, isFirst: upserted.isFirst };
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
    // T53：撤销态剪枝——只保留仍在本卡 items 里的记录（删除/移餐后陈旧撤销态自然清理），
    // 同时把旧 payload 的单槽 last_change 归一成 last_changes 数组（读兼容）。
    const itemIds = new Set(view.items.map((it) => it.record_id));
    const last_changes = readLastChanges(m.payload).filter((c) => itemIds.has(c.record_id));
    const { last_change: _legacy, ...rest } = (m.payload as any);
    return { ...m, payload: { ...rest, ...view, last_changes } };
  });
}
