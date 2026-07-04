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
  [["俯卧撑", "pushup", "push up"], 3.8],
  [["引体向上", "pullup", "pull up", "chin up", "chinup"], 5],
  [["深蹲", "squat"], 5],
  [["仰卧起坐", "卷腹", "situp", "sit up", "crunch"], 3.8],
  [["波比跳", "burpee", "立卧撑"], 8],
  [["开合跳", "jumping jack"], 8],
  [["平板支撑", "plank"], 3],
];

function getMET(type: string): number {
  const lower = type.toLowerCase();
  for (const [keywords, met] of MET_TABLE) {
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) return met;
  }
  return 4;
}

export function calcExerciseCalories(type: string, duration_min: number, weight_kg: number): number {
  return Math.round(getMET(type) * weight_kg * (duration_min / 60));
}

// T50：用户在 record 消息里自报消耗则直接采信（用户真值，不算账），否则回落 MET 估算。
// exercise_record 无 calories_source 字段，也不需要——它从不被后台重算，用户值写入即安全。
export function resolveExerciseCalories(
  ex: { type: string; duration_min?: number; reps?: number; calories_burned?: number },
  duration_min: number,
  weight_kg: number,
): { calories_burned: number; user_reported: boolean } {
  if (ex.calories_burned != null) {
    return { calories_burned: Math.round(ex.calories_burned), user_reported: true };
  }
  return { calories_burned: calcExerciseCalories(ex.type, duration_min, weight_kg), user_reported: false };
}

export function resolveDuration(ex: { duration_min?: number; reps?: number }): number {
  if (ex.duration_min) return ex.duration_min;
  if (ex.reps) return Math.max(1, Math.round(ex.reps / 15));
  return 30;
}
