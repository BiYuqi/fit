export type MessageKind =
  | 'text'
  | 'record_card'
  | 'portion_card'
  | 'candidate_card'
  | 'clarify_card'
  | 'query_card'
  | 'exercise_card'
  | 'delete_confirm_card';

export type ChatMessage = {
  id: string;
  date: string;
  role: 'user' | 'assistant';
  kind: MessageKind;
  content?: string | null;
  payload?: Record<string, unknown> | null;
  record_id?: string | null;
  created_at: string;
};

export type UndoPrevState = {
  food_id: string;
  portion_label: string;
  weight_g: number;
} | {
  calories_burned: number;
  kind: 'exercise';
};

export type RecordUndo = {
  record_id: string;
  prev_state?: UndoPrevState; // 有=update 撤销(还原)，无=append 撤销(删除)
};

export type FoodAliasEscape = {
  canonical: string;
  portions: PortionOption[];
  chosen_label: string;
  ai_candidates?: string[];
};

export type RecordCardPayload = {
  food_name: string;
  weight_g: number;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  meal_type?: string; // breakfast/lunch/dinner/snack；旧消息无此字段，卡片不显示餐次
  is_estimated?: boolean;
  unit?: string;
  undo?: RecordUndo; // modify 的 update/append 直执行时带，支持撤销
  matched_by_habit?: boolean; // 用户食物直连（streak≥2）自动匹配，见 LEARNING_SPEC §6 §7
  escape?: FoodAliasEscape; // 「不是它？」逃生口所需数据
  bias_applied?: { from: number; to: number }; // 份量偏差修正 AI原估→实记（T31，前端可不展示，discuss/debug 用）
};

export type DeleteConfirmCardPayload = {
  pending_id: string;
  record_id: string;
  name: string;
  meal_type?: string;
  calories?: number;
  resolved?: boolean;
};

export type PortionOption = { label: string; grams: number; calories?: number; unit?: 'g' | 'ml' };

export type PortionCardPayload = {
  pending_id: string;
  food_name: string;
  portions: PortionOption[];
  resolved?: boolean;
  resolved_portion?: string;
  resolved_grams?: number;
  resolved_unit?: string;
};

export type CandidateFood = {
  name: string;
  calorie_hint?: number; // 默认中份热量提示，DB 有记录时才有
};

export type CandidateCardPayload = {
  pending_id: string;
  query: string;
  foods: CandidateFood[];
  resolved?: boolean;
};

export type ClarifyCardPayload = {
  pending_id: string;
  query: string;
  portions?: PortionOption[];
  resolved?: boolean;
};

export type ContextCard = {
  today: {
    in: number;
    out: number;
    deficit: number;
    p: number;
    f: number;
    c: number;
    remaining: number;
  };
  targets: { calories: number; protein: number };
  week: { avg_deficit: number; logged_days: number };
  month: { logged_days: number; avg_in: number };
};

export type ExerciseCardPayload = {
  exercise_id: string;
  type: string;
  duration_min: number;
  calories_burned: number;
  undo?: RecordUndo;
};

export type SendMessageResponse = {
  intent: 'record' | 'query' | 'chat' | 'modify';
  reply: string;
  record?: unknown;
  pending?: unknown;
  summary_card?: ContextCard;
  messages: ChatMessage[];
};

export type ResolveResponse = {
  record?: unknown;
  summary_card: ContextCard;
  messages: ChatMessage[];
};
