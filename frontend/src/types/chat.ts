export type MessageKind =
  | 'text'
  | 'record_card'
  | 'meal_card'
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
  meal_type?: string; // 改餐次的撤销还原
  // T40：改前的精确营养快照，齐全时后端直接还原这些值（不按 food×grams 重算）；
  // 前端只需原样透传给 /api/records/:id/undo，不用读取
  calories?: number;
  protein?: number;
  fat?: number;
  carbs?: number;
  calories_source?: string;
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

// T46/T47 餐食卡：一餐一卡。落库只有 meal_key/last_change，items/totals/item_count
// 由后端在响应/GET 时从 food_record 实时组装（items: [] = 该餐已清空）。
// 内容变更时后端刷新同一条消息的 created_at——前端按 id upsert + 按 created_at 重排（见 lib/messages.ts）。
export type MealCardItem = {
  record_id: string;
  food_name: string;
  raw_input: string | null; // 明细主显示（用户原话子句）；空时用 food_name + weight_g 兜底
  weight_g: number;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  is_estimated: boolean;
  portion_label: string;
};

export type MealCardPayload = {
  meal_key: { date: string; meal_type: string };
  last_change?: { record_id: string; prev_state?: UndoPrevState } | null; // 单槽撤销（T48 渲染项级撤销按钮）
  items: MealCardItem[];
  totals: { calories: number; protein_g: number; fat_g: number; carbs_g: number };
  item_count: number;
};

export type ExerciseCardPayload = {
  exercise_id: string;
  type: string;
  duration_min: number;
  calories_burned: number;
  undo?: RecordUndo;
};

export type SendMessageResponse = {
  intent: 'record' | 'query' | 'chat' | 'modify' | 'discuss' | 'resolve_pending' | 'multi';
  reply: string;
  record?: unknown;
  pending?: unknown;
  summary_card?: ContextCard;
  messages: ChatMessage[];
  // T38：本轮若通过打字回答了某张【待确认】卡片，带上它的 pending_id，
  // 让前端把聊天流里那张旧卡就地标记为已确认（否则用户还能再点一次）。
  resolved_pending_id?: string;
};

export type ResolveResponse = {
  record?: unknown;
  summary_card: ContextCard;
  messages: ChatMessage[];
};
