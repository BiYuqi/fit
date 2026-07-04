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
  daily_deficit?: number;  // default 500, range 150–1500
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

// T40：用户直接指定食物记录的最终热量（用户真值）时，按同一比例回推宏量素，
// 而不是简单把 protein/fat/carbs 清零——用户纠正的是总量口径（如"少放了油"），营养结构大体不变。
export function scaleNutritionToCalories(nutrition: ItemNutrition, calories: number): ItemNutrition {
  const ratio = nutrition.calories > 0 ? calories / nutrition.calories : 0;
  return {
    calories,
    protein_g: nutrition.protein_g * ratio,
    fat_g: nutrition.fat_g * ratio,
    carbs_g: nutrition.carbs_g * ratio,
    fiber_g: nutrition.fiber_g != null ? nutrition.fiber_g * ratio : null,
    incomplete: nutrition.incomplete,
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
