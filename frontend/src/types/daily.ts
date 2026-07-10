// GET /api/daily/today 响应（Today 页 + today 缓存写穿共用）
export interface DailySummary {
  calories_in: number; total_out: number; deficit: number;
  tdee: number; exercise_out: number; protein: number; fat: number; carbs: number;
  target_calories: number; target_protein: number;
}

export interface ExerciseRecord {
  id: string;
  type: string;
  duration_min: number | null;
  calories_burned: number;
}

export interface TodayResponse {
  summary: DailySummary | null;
  exercises: ExerciseRecord[];
}
