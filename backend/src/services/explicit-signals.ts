// 明示信号抽取（确定性，零 LLM 调用）
//
// "明示信号" = 用户在原话里明确说出口的值：热量、克数、日期词、餐次词、指令+数值、主料名。
// 这类信息不需要模型推断，也因此**可以在不调用 LLM 的前提下机器校验有没有被系统采纳**——
// 这是"用户明说了但系统没照做"这一类失败能被自动发现（而不是等用户骂）的基础。
//
// 当前消费方：scripts/audit.ts（离线扫历史日志出可疑清单）。
// 后续消费方：解析链路的运行时校验。两边必须共用本文件，不要各写一份（QUICK/FULL 提取 prompt
// 曾因两份定义漂移而漏改，教训见 docs/tasks/T59）。

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export interface MealHit {
  meal: MealType;
  word: string;
  index: number; // 在原文中的位置，供"多信号消歧"判断先后
  attributive: boolean; // 是否"时段词+的"定语用法（"早晨的饼"修饰名词，不是进食动作）
}

export interface ExplicitSignals {
  /** 显式热量："80卡"、"850大卡" */
  calories: number[];
  /** 显式重量/容量："850克"、"200毫升"（斤已换算成克） */
  weights: Array<{ value: number; unit: "g" | "ml"; raw: string }>;
  /** 相对日期词 → 相对今天的天数偏移（-1=昨天） */
  dateOffset: number | null;
  /** 餐次词命中（可能多个，multi=true 表示存在歧义） */
  meals: MealHit[];
  /** 指令动词 + 数值："改成850" */
  instructions: Array<{ verb: string; value: number }>;
  /** 原话里出现的主料名（肉蛋鱼虾豆） */
  ingredients: string[];
  /**
   * 用户要求的是"派生值"而非字面值——如"不去芯是340克，你算下去芯的"、
   * "纯肉不算骨头"。此时原话里的数字/食材**不应**被期待原样落库，
   * 校验须跳过，否则误报（实测这是最主要的误报来源）。
   */
  derivedRequest: boolean;
}

// ── 词表 ──

const RE_CALORIE = /(\d+(?:\.\d+)?)\s*(?:大卡|千卡|kcal|卡(?![片路通]))/gi;
const RE_WEIGHT = /(\d+(?:\.\d+)?)\s*(克|毫升|ml|g|斤)(?![a-z])/gi;
const RE_INSTRUCTION = /(改成|改为|改到|记成|记录成|算作|调成|调到|按)\s*(\d+(?:\.\d+)?)/g;

const DATE_WORDS: Array<[string, number]> = [
  ["大前天", -3],
  ["前天", -2],
  ["昨晚上", -1],
  ["昨晚", -1],
  ["昨日", -1],
  ["昨天", -1],
];

const MEAL_WORDS: Array<[MealType, string]> = [
  ["breakfast", "早上"], ["breakfast", "早晨"], ["breakfast", "早饭"],
  ["breakfast", "早餐"], ["breakfast", "上午"],
  ["lunch", "中午"], ["lunch", "午饭"], ["lunch", "午餐"], ["lunch", "中饭"],
  ["dinner", "晚上"], ["dinner", "晚饭"], ["dinner", "晚餐"], ["dinner", "傍晚"],
  ["snack", "下午茶"], ["snack", "下午"], ["snack", "加餐"], ["snack", "零食"],
];

/** 主料名 → 可接受的 canonical 写法（归一同义词，避免"鸡蛋→水煮蛋"被误判成丢主料） */
const INGREDIENT_SYNONYMS: Record<string, string[]> = {
  鸡胸肉: ["鸡胸", "鸡肉"],
  鸡腿: ["鸡腿", "鸡肉"],
  鸡肉: ["鸡"],
  牛肉: ["牛肉"],
  猪肉: ["猪肉", "瘦肉", "里脊", "五花"],
  羊肉: ["羊肉"],
  排骨: ["排骨", "肋排"],
  牛排: ["牛排", "牛肉"],
  鸭肉: ["鸭"],
  虾: ["虾"],
  鱼: ["鱼"],
  鸡蛋: ["蛋"],
  豆腐: ["豆腐", "豆制品"],
  培根: ["培根"],
  火腿: ["火腿"],
};
const INGREDIENTS = Object.keys(INGREDIENT_SYNONYMS);

/** 派生值请求标志：命中即跳过字面校验 */
const DERIVED_MARKERS = [
  "去芯", "去皮", "去骨", "不算骨", "不含", "不算", "不要", "净重", "毛重",
  "你算", "你计算", "算下", "算一下", "计算下", "帮我算",
];

// ── 抽取 ──

export function extractExplicitSignals(text: string): ExplicitSignals {
  const calories: number[] = [];
  for (const m of text.matchAll(RE_CALORIE)) calories.push(parseFloat(m[1]));

  const weights: ExplicitSignals["weights"] = [];
  for (const m of text.matchAll(RE_WEIGHT)) {
    const v = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    if (u === "斤") weights.push({ value: v * 500, unit: "g", raw: m[0] });
    else if (u === "毫升" || u === "ml") weights.push({ value: v, unit: "ml", raw: m[0] });
    else weights.push({ value: v, unit: "g", raw: m[0] });
  }

  let dateOffset: number | null = null;
  for (const [w, off] of DATE_WORDS) {
    if (text.includes(w)) { dateOffset = off; break; }
  }

  const meals: MealHit[] = [];
  for (const [meal, word] of MEAL_WORDS) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(word, from);
      if (i === -1) break;
      // 已被更长的词覆盖过就跳过（"下午茶" 命中后不再记 "下午"）
      const covered = meals.some((h) => i >= h.index && i < h.index + h.word.length);
      if (!covered) {
        meals.push({
          meal,
          word,
          index: i,
          attributive: text.slice(i + word.length, i + word.length + 1) === "的",
        });
      }
      from = i + word.length;
    }
  }
  meals.sort((a, b) => a.index - b.index);

  const instructions: ExplicitSignals["instructions"] = [];
  for (const m of text.matchAll(RE_INSTRUCTION)) {
    instructions.push({ verb: m[1], value: parseFloat(m[2]) });
  }

  const ingredients = INGREDIENTS.filter((w) => text.includes(w));

  return {
    calories,
    weights,
    dateOffset,
    meals,
    instructions,
    ingredients,
    derivedRequest: DERIVED_MARKERS.some((k) => text.includes(k)),
  };
}

/** 餐次词是否存在多信号歧义（2 种以上不同餐次同现） */
export function hasMealAmbiguity(s: ExplicitSignals): boolean {
  return new Set(s.meals.map((m) => m.meal)).size > 1;
}

/** 某个主料是否已被一组 canonical 覆盖（含同义写法） */
export function ingredientCovered(ingredient: string, canonicals: string[]): boolean {
  const hay = canonicals.join(" ");
  if (hay.includes(ingredient)) return true;
  return (INGREDIENT_SYNONYMS[ingredient] ?? []).some((syn) => hay.includes(syn));
}
