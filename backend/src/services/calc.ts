export type Sex = "male" | "female";
export type ActivityLevel =
  | "sedentary"
  | "light"
  | "moderate"
  | "active"
  | "very_active";

export interface UserProfile {
  weight_kg: number;
  height_cm: number;
  age: number;
  sex: Sex;
  activity_level: ActivityLevel;
  daily_deficit?: number;  // default 500, range 300–750
  protein_factor?: number; // default 1.8, range 1.6–2.2
}

export interface FoodNutrient {
  calories_100g: number | null;
  protein_100g: number | null;
  fat_100g: number | null;
  carbs_100g: number | null;
  fiber_100g?: number | null;
}

export interface ItemNutrition {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g: number | null;
  incomplete: boolean;
}

export interface DailyTargets {
  target_calories: number;
  target_protein_g: number;
}

const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export function bmr(user: UserProfile): number {
  const base = 10 * user.weight_kg + 6.25 * user.height_cm - 5 * user.age;
  return user.sex === "male" ? base + 5 : base - 161;
}

export function tdee(user: UserProfile): number {
  return bmr(user) * ACTIVITY_MULTIPLIERS[user.activity_level];
}

export function itemNutrition(food: FoodNutrient, weight_g: number): ItemNutrition {
  const factor = weight_g / 100;
  const incomplete =
    food.calories_100g === null ||
    food.protein_100g === null ||
    food.fat_100g === null ||
    food.carbs_100g === null;
  return {
    calories: (food.calories_100g ?? 0) * factor,
    protein_g: (food.protein_100g ?? 0) * factor,
    fat_g: (food.fat_100g ?? 0) * factor,
    carbs_g: (food.carbs_100g ?? 0) * factor,
    fiber_g: food.fiber_100g != null ? food.fiber_100g * factor : null,
    incomplete,
  };
}

export function dailyTargets(user: UserProfile): DailyTargets {
  const deficit = user.daily_deficit ?? 500;
  const pFactor = user.protein_factor ?? 1.8;
  return {
    target_calories: Math.round(tdee(user) - deficit),
    target_protein_g: Math.round(user.weight_kg * pFactor),
  };
}
