import type { MealType } from "@prisma/client";

// UTC+8 (Asia/Shanghai): shift to local midnight
export function todayStr(): string {
  const local = new Date(Date.now() + 8 * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

export function toDateOnly(date: string): Date {
  return new Date(date + "T00:00:00.000Z");
}

// Use UTC+8 (Asia/Shanghai) local hour to avoid server UTC offset
export function guessMealType(): MealType {
  const h = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  if (h >= 5 && h < 10) return "breakfast";
  if (h >= 10 && h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  return "snack";
}

// 从原始文本中提取餐次，优先级高于 AI 结果和时间推断
export function extractMealTypeFromText(text: string): MealType | null {
  if (/早上|早晨|早饭|早餐|上午/.test(text)) return "breakfast";
  if (/中午|午饭|午餐|中饭/.test(text)) return "lunch";
  if (/晚上|晚饭|晚餐|傍晚/.test(text)) return "dinner";
  if (/下午茶|下午|加餐|零食/.test(text)) return "snack";
  return null;
}
