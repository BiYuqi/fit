import { strict as assert } from "node:assert";
import { test } from "node:test";
import { bmr, tdee, itemNutrition, dailyTargets } from "./calc";
import type { UserProfile, FoodNutrient } from "./calc";

// 基准用户：70kg 175cm 30岁 男 中度活动
const maleUser: UserProfile = {
  weight_kg: 70,
  height_cm: 175,
  age: 30,
  sex: "male",
  activity_level: "moderate",
};

// 女性用户：60kg 165cm 28岁 轻度活动
const femaleUser: UserProfile = {
  weight_kg: 60,
  height_cm: 165,
  age: 28,
  sex: "female",
  activity_level: "light",
};

test("bmr — 男性 Mifflin-St Jeor", () => {
  // 10*70 + 6.25*175 - 5*30 + 5 = 700 + 1093.75 - 150 + 5 = 1648.75
  assert.equal(bmr(maleUser), 1648.75);
});

test("bmr — 女性 Mifflin-St Jeor", () => {
  // 10*60 + 6.25*165 - 5*28 - 161 = 600 + 1031.25 - 140 - 161 = 1330.25
  assert.equal(bmr(femaleUser), 1330.25);
});

test("tdee — 男性中度活动", () => {
  // 1648.75 * 1.55 = 2555.5625
  assert.equal(tdee(maleUser), 1648.75 * 1.55);
});

test("tdee — 女性轻度活动", () => {
  // 1330.25 * 1.375
  assert.equal(tdee(femaleUser), 1330.25 * 1.375);
});

test("itemNutrition — 正常食物 100g", () => {
  const food: FoodNutrient = {
    calories_100g: 200,
    protein_100g: 10,
    fat_100g: 5,
    carbs_100g: 30,
    fiber_100g: 2,
  };
  const result = itemNutrition(food, 100);
  assert.equal(result.calories, 200);
  assert.equal(result.protein_g, 10);
  assert.equal(result.fat_g, 5);
  assert.equal(result.carbs_g, 30);
  assert.equal(result.fiber_g, 2);
  assert.equal(result.incomplete, false);
});

test("itemNutrition — 250g 按比例", () => {
  const food: FoodNutrient = {
    calories_100g: 120,
    protein_100g: 8,
    fat_100g: 3,
    carbs_100g: 20,
  };
  const result = itemNutrition(food, 250);
  assert.equal(result.calories, 300);
  assert.equal(result.protein_g, 20);
  assert.equal(result.fat_g, 7.5);
  assert.equal(result.carbs_g, 50);
  assert.equal(result.fiber_g, null);
  assert.equal(result.incomplete, false);
});

test("itemNutrition — 营养字段 null 不崩，标 incomplete", () => {
  const food: FoodNutrient = {
    calories_100g: null,
    protein_100g: null,
    fat_100g: null,
    carbs_100g: null,
  };
  const result = itemNutrition(food, 200);
  assert.equal(result.calories, 0);
  assert.equal(result.protein_g, 0);
  assert.equal(result.fat_g, 0);
  assert.equal(result.carbs_g, 0);
  assert.equal(result.incomplete, true);
});

test("itemNutrition — 部分 null 标 incomplete", () => {
  const food: FoodNutrient = {
    calories_100g: 150,
    protein_100g: null,
    fat_100g: 5,
    carbs_100g: 20,
  };
  const result = itemNutrition(food, 100);
  assert.equal(result.calories, 150);
  assert.equal(result.protein_g, 0);
  assert.equal(result.incomplete, true);
});

test("dailyTargets — 默认缺口 500，蛋白系数 1.8", () => {
  const targets = dailyTargets(maleUser);
  const expectedCal = Math.round(tdee(maleUser) - 500);
  const expectedPro = Math.round(70 * 1.8);
  assert.equal(targets.target_calories, expectedCal);
  assert.equal(targets.target_protein_g, expectedPro);
});

test("dailyTargets — 自定义缺口与蛋白系数", () => {
  const user: UserProfile = { ...maleUser, daily_deficit: 300, protein_factor: 2.0 };
  const targets = dailyTargets(user);
  assert.equal(targets.target_calories, Math.round(tdee(user) - 300));
  assert.equal(targets.target_protein_g, Math.round(70 * 2.0));
});
