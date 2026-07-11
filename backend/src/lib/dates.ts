import type { MealType } from "@prisma/client";

// ─────────────────────────────────────────────────────────────
// 时区：全项目唯一源。
// 后端所有"今天/几点/归属日"口径都从这里走，别处不许再自己算偏移。
// 默认北京时区；换时区只改 env APP_TZ（IANA 名，如 America/New_York），不动代码。
// 用 Intl 按真实时区算，而不是硬编码 +8 偏移——这样带夏令时的时区也正确。
// ─────────────────────────────────────────────────────────────
export const APP_TZ = process.env.APP_TZ ?? "Asia/Shanghai";

// 把某个时刻在 APP_TZ 下拆成日期/时间零件（YYYY-MM-DD / HH:mm）
function tzParts(d: Date): { date: string; hm: string; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  const year = g("year"), month = g("month"), day = g("day");
  // 某些运行时午夜会给出 "24"，归一到 "00"
  const hour = g("hour") === "24" ? "00" : g("hour");
  return { date: `${year}-${month}-${day}`, hm: `${hour}:${g("minute")}`, month: +month, day: +day };
}

// 某个时刻在 APP_TZ 下的日期字符串 "YYYY-MM-DD"
export function tzDateStr(d: Date): string {
  return tzParts(d).date;
}

// 某个时刻在 APP_TZ 下的 "HH:mm"
export function tzTimeStr(d: Date): string {
  return tzParts(d).hm;
}

// 某个时刻在 APP_TZ 下的 "M月D日"
export function tzMonthDayStr(d: Date): string {
  const p = tzParts(d);
  return `${p.month}月${p.day}日`;
}

// APP_TZ 下的"今天" "YYYY-MM-DD"
export function todayStr(): string {
  return tzDateStr(new Date());
}

// "YYYY-MM-DD" → UTC 午夜 Date（匹配 @db.Date 字段）
export function toDateOnly(date: Date | string): Date {
  const s = typeof date === "string" ? date : tzDateStr(date);
  return new Date(s + "T00:00:00.000Z");
}

// UTC 午夜 Date 平移整数天（负数=过去），仍是 @db.Date 对齐的午夜时刻
export function addOffsetDays(date: Date, offsetDays: number): Date {
  return new Date(date.getTime() + offsetDays * 86400000);
}

// toDateOnly() 产出的 UTC 午夜 Date → "YYYY-MM-DD"。直接读 UTC 日期分量，
// 不走 tzDateStr（那是给真实时刻按 APP_TZ 重新落算日期用的，对已经对齐好的
// 日期值再套时区，遇到 UTC 负偏移的时区会把日期错着算前一天）。
export function dateOnlyStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// 从原始文本中识别相对日期词，换算成相对今天的天数偏移（0=今天，负数=过去）
// 优先级高于 AI 结果（同 extractMealTypeFromText 的既有模式）：封闭词表，正则比模型确定性更高。
// 只覆盖高频"昨天/前天/大前天"补记场景，更早的日期没有可靠的相对说法，交给 AI 兜底或不支持。
export function extractDateOffsetFromText(text: string): number | null {
  if (/大前天/.test(text)) return -3;
  if (/前天/.test(text)) return -2;
  if (/昨天|昨晚|昨日|昨晚上/.test(text)) return -1;
  return null;
}

// 按 APP_TZ 的当前小时推断餐次
export function guessMealType(): MealType {
  const h = +tzTimeStr(new Date()).slice(0, 2);
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 15) return "lunch";
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
