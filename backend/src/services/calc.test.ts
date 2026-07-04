import { strict as assert } from "node:assert";
import { test } from "node:test";
import { bmr, tdee, itemNutrition, dailyTargets, scaleNutritionToCalories } from "./calc";
import type { UserProfile, FoodNutrient } from "./calc";

// 浮点数近似比较（误差 < 0.001）
function approx(actual: number, expected: number, msg?: string) {
  assert.ok(
    Math.abs(actual - expected) < 0.001,
    `${msg ?? ""} expected ≈${expected}, got ${actual}`
  );
}

// ============================================================
// 典型用户档案
// ============================================================

// 30岁男，久坐办公族（最常见减脂用户）
const deskMale: UserProfile = {
  weight_kg: 75,
  height_cm: 175,
  age: 30,
  sex: "male",
  activity_level: "sedentary",
};

// 28岁女，轻度活动
const youngFemale: UserProfile = {
  weight_kg: 55,
  height_cm: 162,
  age: 28,
  sex: "female",
  activity_level: "light",
};

// 45岁男，中年微胖，中度活动
const midMale: UserProfile = {
  weight_kg: 85,
  height_cm: 172,
  age: 45,
  sex: "male",
  activity_level: "moderate",
};

// 22岁女，健身党，高强度活动
const fitFemale: UserProfile = {
  weight_kg: 52,
  height_cm: 165,
  age: 22,
  sex: "female",
  activity_level: "active",
};

// 60岁女，久坐
const seniorFemale: UserProfile = {
  weight_kg: 65,
  height_cm: 158,
  age: 60,
  sex: "female",
  activity_level: "sedentary",
};

// ============================================================
// 常见中国食物营养数据（每100g，来自《中国食物成分表第6版》近似值）
// ============================================================

const 白米饭: FoodNutrient = { calories_100g: 116, protein_100g: 2.6, fat_100g: 0.3, carbs_100g: 25.9, fiber_100g: 0.3 };
const 馒头: FoodNutrient  = { calories_100g: 223, protein_100g: 7.0, fat_100g: 1.1, carbs_100g: 47.0, fiber_100g: 1.3 };
const 面条煮: FoodNutrient = { calories_100g: 109, protein_100g: 3.9, fat_100g: 0.5, carbs_100g: 24.3, fiber_100g: null };
const 猪五花: FoodNutrient = { calories_100g: 395, protein_100g: 7.7, fat_100g: 35.3, carbs_100g: 2.4, fiber_100g: null };
const 鸡胸肉: FoodNutrient = { calories_100g: 133, protein_100g: 23.5, fat_100g: 3.6, carbs_100g: 0.2, fiber_100g: null };
const 鸡蛋: FoodNutrient   = { calories_100g: 139, protein_100g: 13.0, fat_100g: 8.6, carbs_100g: 2.4, fiber_100g: null };
const 北豆腐: FoodNutrient = { calories_100g: 98,  protein_100g: 12.2, fat_100g: 4.8, carbs_100g: 1.5, fiber_100g: 0.4 };
const 大白菜: FoodNutrient = { calories_100g: 13,  protein_100g: 1.0,  fat_100g: 0.1, carbs_100g: 3.2, fiber_100g: 0.6 };
const 花生仁: FoodNutrient = { calories_100g: 563, protein_100g: 24.8, fat_100g: 44.3, carbs_100g: 21.7, fiber_100g: 6.3 };
const 油条: FoodNutrient   = { calories_100g: 388, protein_100g: 6.9,  fat_100g: 17.6, carbs_100g: 51.0, fiber_100g: 0.8 };
const 猪肝: FoodNutrient   = { calories_100g: 129, protein_100g: 19.3, fat_100g: 3.5, carbs_100g: 5.0, fiber_100g: null };
const 带鱼: FoodNutrient   = { calories_100g: 127, protein_100g: 17.7, fat_100g: 4.9, carbs_100g: 3.1, fiber_100g: null };
const 苹果: FoodNutrient   = { calories_100g: 53,  protein_100g: 0.2,  fat_100g: 0.2, carbs_100g: 13.7, fiber_100g: 1.7 };
const 香蕉: FoodNutrient   = { calories_100g: 93,  protein_100g: 1.4,  fat_100g: 0.2, carbs_100g: 22.0, fiber_100g: 1.2 };

// ============================================================
// BMR 测试
// ============================================================

test("bmr — 男性基础公式", () => {
  // 10*75 + 6.25*175 - 5*30 + 5 = 750 + 1093.75 - 150 + 5 = 1698.75
  assert.equal(bmr(deskMale), 1698.75);
});

test("bmr — 女性基础公式", () => {
  // 10*55 + 6.25*162 - 5*28 - 161 = 550 + 1012.5 - 140 - 161 = 1261.5
  assert.equal(bmr(youngFemale), 1261.5);
});

test("bmr — 中年男性体重偏重", () => {
  // 10*85 + 6.25*172 - 5*45 + 5 = 850 + 1075 - 225 + 5 = 1705
  assert.equal(bmr(midMale), 1705);
});

test("bmr — 老年女性基础代谢低", () => {
  // 10*65 + 6.25*158 - 5*60 - 161 = 650 + 987.5 - 300 - 161 = 1176.5
  assert.equal(bmr(seniorFemale), 1176.5);
});

test("bmr — 体重越大 BMR 越高（男性同条件）", () => {
  const light: UserProfile = { ...deskMale, weight_kg: 60 };
  const heavy: UserProfile = { ...deskMale, weight_kg: 100 };
  assert.ok(bmr(light) < bmr(heavy));
});

test("bmr — 年龄越大 BMR 越低（同条件）", () => {
  const young: UserProfile = { ...deskMale, age: 25 };
  const old: UserProfile   = { ...deskMale, age: 55 };
  assert.ok(bmr(young) > bmr(old));
});

// ============================================================
// TDEE 测试
// ============================================================

test("tdee — 久坐系数 1.2", () => {
  approx(tdee(deskMale), bmr(deskMale) * 1.2);
});

test("tdee — 轻度活动系数 1.375", () => {
  approx(tdee(youngFemale), bmr(youngFemale) * 1.375);
});

test("tdee — 中度活动系数 1.55", () => {
  approx(tdee(midMale), bmr(midMale) * 1.55);
});

test("tdee — 高强度活动系数 1.725", () => {
  approx(tdee(fitFemale), bmr(fitFemale) * 1.725);
});

test("tdee — 极高活动系数 1.9", () => {
  const marathon: UserProfile = { ...deskMale, activity_level: "very_active" };
  approx(tdee(marathon), bmr(deskMale) * 1.9);
});

test("tdee — 活动量越高 TDEE 越高（同人）", () => {
  const sed: UserProfile  = { ...deskMale, activity_level: "sedentary" };
  const act: UserProfile  = { ...deskMale, activity_level: "active" };
  const vact: UserProfile = { ...deskMale, activity_level: "very_active" };
  assert.ok(tdee(sed) < tdee(act));
  assert.ok(tdee(act) < tdee(vact));
});

// ============================================================
// itemNutrition — 主食
// ============================================================

test("食物-白米饭 200g（一碗）", () => {
  const r = itemNutrition(白米饭, 200);
  approx(r.calories, 232);
  approx(r.protein_g, 5.2);
  approx(r.fat_g, 0.6);
  approx(r.carbs_g, 51.8);
  approx(r.fiber_g!, 0.6);
  assert.equal(r.incomplete, false);
});

test("食物-馒头 75g（一个中等馒头）", () => {
  const r = itemNutrition(馒头, 75);
  approx(r.calories, 167.25);
  approx(r.protein_g, 5.25);
  approx(r.carbs_g, 35.25);
  assert.equal(r.incomplete, false);
});

test("食物-面条(煮) 250g（一碗面）", () => {
  const r = itemNutrition(面条煮, 250);
  approx(r.calories, 272.5);
  approx(r.protein_g, 9.75);
  approx(r.carbs_g, 60.75);
  assert.equal(r.fiber_g, null);  // 纤维字段无数据
  assert.equal(r.incomplete, false);
});

test("食物-油条 70g（一根）", () => {
  const r = itemNutrition(油条, 70);
  approx(r.calories, 271.6);
  approx(r.fat_g, 12.32);
  approx(r.carbs_g, 35.7);
  assert.equal(r.incomplete, false);
});

// ============================================================
// itemNutrition — 荤菜
// ============================================================

test("食物-猪五花 100g（高脂警示）", () => {
  const r = itemNutrition(猪五花, 100);
  approx(r.calories, 395);
  approx(r.fat_g, 35.3);  // 脂肪极高
  assert.equal(r.incomplete, false);
});

test("食物-猪五花 150g（BBQ/火锅一份）", () => {
  const r = itemNutrition(猪五花, 150);
  approx(r.calories, 592.5);
  approx(r.fat_g, 52.95);
  assert.equal(r.incomplete, false);
});

test("食物-鸡胸肉 200g（一整块）", () => {
  const r = itemNutrition(鸡胸肉, 200);
  approx(r.calories, 266);
  approx(r.protein_g, 47);   // 高蛋白低脂
  approx(r.fat_g, 7.2);
  assert.equal(r.incomplete, false);
});

test("食物-鸡蛋 55g（一个）", () => {
  const r = itemNutrition(鸡蛋, 55);
  approx(r.calories, 76.45);
  approx(r.protein_g, 7.15);
  approx(r.fat_g, 4.73);
  assert.equal(r.incomplete, false);
});

test("食物-带鱼 150g（清蒸一条）", () => {
  const r = itemNutrition(带鱼, 150);
  approx(r.calories, 190.5);
  approx(r.protein_g, 26.55);
  approx(r.fat_g, 7.35);
  assert.equal(r.incomplete, false);
});

test("食物-猪肝 100g（补铁常见食材）", () => {
  const r = itemNutrition(猪肝, 100);
  approx(r.calories, 129);
  approx(r.protein_g, 19.3);
  assert.equal(r.incomplete, false);
});

// ============================================================
// itemNutrition — 豆制品 / 蔬菜 / 水果
// ============================================================

test("食物-北豆腐 150g（一块）", () => {
  const r = itemNutrition(北豆腐, 150);
  approx(r.calories, 147);
  approx(r.protein_g, 18.3);
  approx(r.fat_g, 7.2);
  assert.equal(r.incomplete, false);
});

test("食物-大白菜 200g（低热量蔬菜）", () => {
  const r = itemNutrition(大白菜, 200);
  approx(r.calories, 26);   // 极低热量
  approx(r.protein_g, 2);
  approx(r.fat_g, 0.2);
  assert.equal(r.incomplete, false);
});

test("食物-苹果 200g（一个中等）", () => {
  const r = itemNutrition(苹果, 200);
  approx(r.calories, 106);
  approx(r.carbs_g, 27.4);
  approx(r.fiber_g!, 3.4);
  assert.equal(r.incomplete, false);
});

test("食物-香蕉 120g（一根去皮）", () => {
  const r = itemNutrition(香蕉, 120);
  approx(r.calories, 111.6);
  approx(r.carbs_g, 26.4);
  assert.equal(r.incomplete, false);
});

// ============================================================
// itemNutrition — 零食 / 高热量
// ============================================================

test("食物-花生仁 30g（一把，常见零食）", () => {
  const r = itemNutrition(花生仁, 30);
  approx(r.calories, 168.9);  // 小份但高热
  approx(r.fat_g, 13.29);
  approx(r.protein_g, 7.44);
  approx(r.fiber_g!, 1.89);
  assert.equal(r.incomplete, false);
});

test("食物-花生仁 100g（热量密度验证：全是脂肪）", () => {
  const r = itemNutrition(花生仁, 100);
  approx(r.calories, 563);
  approx(r.fat_g, 44.3);  // 高脂
  assert.equal(r.incomplete, false);
});

// ============================================================
// itemNutrition — null 与边界场景
// ============================================================

test("null — 仅膳食纤维 null，不标 incomplete", () => {
  // 膳食纤维 null 不影响 incomplete（incomplete 只看四大主字段）
  const r = itemNutrition(面条煮, 100);
  assert.equal(r.fiber_g, null);
  assert.equal(r.incomplete, false);
});

test("null — calories 为 null，标 incomplete，热量按 0 计", () => {
  const food: FoodNutrient = { calories_100g: null, protein_100g: 5, fat_100g: 2, carbs_100g: 10 };
  const r = itemNutrition(food, 100);
  assert.equal(r.calories, 0);
  assert.equal(r.incomplete, true);
});

test("null — 四大字段全 null 不崩，全输出 0", () => {
  const food: FoodNutrient = { calories_100g: null, protein_100g: null, fat_100g: null, carbs_100g: null };
  const r = itemNutrition(food, 200);
  assert.equal(r.calories, 0);
  assert.equal(r.protein_g, 0);
  assert.equal(r.fat_g, 0);
  assert.equal(r.carbs_g, 0);
  assert.equal(r.fiber_g, null);
  assert.equal(r.incomplete, true);
});

test("份量-极小份 10g（尝一口）", () => {
  const r = itemNutrition(白米饭, 10);
  approx(r.calories, 11.6);
  approx(r.protein_g, 0.26);
  assert.equal(r.incomplete, false);
});

test("份量-超大份 1000g（火锅蔬菜一整盆）", () => {
  const r = itemNutrition(大白菜, 1000);
  approx(r.calories, 130);  // 1kg白菜才130kcal
  assert.equal(r.incomplete, false);
});

// ============================================================
// dailyTargets — 各类减脂目标
// ============================================================

test("目标-久坐男默认（缺口500，蛋白1.8）", () => {
  const t = dailyTargets(deskMale);
  assert.equal(t.target_calories, Math.round(tdee(deskMale) - 500));
  assert.equal(t.target_protein_g, Math.round(75 * 1.8));
});

test("目标-年轻女轻度活动默认", () => {
  const t = dailyTargets(youngFemale);
  assert.equal(t.target_calories, Math.round(tdee(youngFemale) - 500));
  assert.equal(t.target_protein_g, Math.round(55 * 1.8));
});

test("目标-激进缺口 750（快速减脂）", () => {
  const user: UserProfile = { ...deskMale, daily_deficit: 750 };
  const t = dailyTargets(user);
  assert.equal(t.target_calories, Math.round(tdee(deskMale) - 750));
});

test("目标-保守缺口 300（慢速减脂）", () => {
  const user: UserProfile = { ...deskMale, daily_deficit: 300 };
  const t = dailyTargets(user);
  assert.equal(t.target_calories, Math.round(tdee(deskMale) - 300));
});

test("目标-高蛋白系数 2.2（力量训练）", () => {
  const user: UserProfile = { ...fitFemale, protein_factor: 2.2 };
  const t = dailyTargets(user);
  assert.equal(t.target_protein_g, Math.round(52 * 2.2));
});

test("目标-低蛋白系数 1.6（保守估计）", () => {
  const user: UserProfile = { ...youngFemale, protein_factor: 1.6 };
  const t = dailyTargets(user);
  assert.equal(t.target_protein_g, Math.round(55 * 1.6));
});

test("目标-久坐者热量目标 < 活跃者（同体型同缺口）", () => {
  const sed: UserProfile  = { ...deskMale, activity_level: "sedentary" };
  const act: UserProfile  = { ...deskMale, activity_level: "active" };
  assert.ok(dailyTargets(sed).target_calories < dailyTargets(act).target_calories);
});

test("目标-中年男热量需求低于年轻男（同体型活动量）", () => {
  const young: UserProfile = { ...deskMale, age: 25 };
  const mid: UserProfile   = { ...deskMale, age: 45 };
  assert.ok(dailyTargets(young).target_calories > dailyTargets(mid).target_calories);
});

// ============================================================
// T40：scaleNutritionToCalories —— 用户直接指定热量后按比例回推宏量素
// ============================================================

test("T40-回推：热量减半，蛋白/脂肪/碳水同步减半（比例不变）", () => {
  const n = itemNutrition(油条, 70); // 267kcal, 蛋白5.95g, 脂肪12.11g, 碳水33.32g（葱花饼案例量级）
  const half = scaleNutritionToCalories(n, n.calories / 2);
  assert.equal(half.calories, n.calories / 2);
  approx(half.protein_g, n.protein_g / 2);
  approx(half.fat_g, n.fat_g / 2);
  approx(half.carbs_g, n.carbs_g / 2);
  approx(half.fiber_g!, n.fiber_g! / 2);
});

test("T40-回推：热量调高，宏量素同比例调高", () => {
  const n = itemNutrition(白米饭, 200);
  const scaled = scaleNutritionToCalories(n, n.calories * 1.5);
  assert.equal(scaled.calories, n.calories * 1.5);
  approx(scaled.protein_g, n.protein_g * 1.5);
  approx(scaled.carbs_g, n.carbs_g * 1.5);
});

test("T40-回推：原热量为 0 时不除以 0，宏量素归零而非 NaN/Infinity", () => {
  const zeroNutrition = { calories: 0, protein_g: 5, fat_g: 2, carbs_g: 10, fiber_g: 1, incomplete: false };
  const out = scaleNutritionToCalories(zeroNutrition, 180);
  assert.equal(out.calories, 180);
  assert.equal(out.protein_g, 0);
  assert.equal(out.fat_g, 0);
  assert.equal(out.carbs_g, 0);
  assert.equal(out.fiber_g, 0);
});

test("T40-回推：fiber_g 原为 null 时保持 null（不是 0）", () => {
  const n: ReturnType<typeof itemNutrition> = { calories: 100, protein_g: 5, fat_g: 2, carbs_g: 10, fiber_g: null, incomplete: false };
  const out = scaleNutritionToCalories(n, 200);
  assert.equal(out.fiber_g, null);
});
