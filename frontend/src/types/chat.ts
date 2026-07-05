export type MessageKind =
  | 'text'
  | 'meal_card'
  | 'portion_card'
  | 'candidate_card'
  | 'clarify_card'
  | 'exercise_card'
  | 'delete_confirm_card'
  | 'event';

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

// T49：回执降级为居中小字事件行。text 由后端组装好（铁律1：数字来自后端）。
// undo 仅 event_type=deleted 时有（record 已被真删除，需按快照重建，走 /api/chat/events/:id/undo）；
// modified 事件的撤销走 meal_card 项级 last_change（同一条 undo 链路，谁可见用谁），不在这里带 undo。
export type EventCardPayload = {
  event_type: 'deleted' | 'modified';
  text: string;
  record_id?: string;
  undo?: { prev_state: Record<string, unknown> };
  undone: boolean;
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
  food_name: string; // 明细主显示（T52）：有 count 时拼 `食物名 ×count`，否则 `食物名 weight_g`
  count: number | null; // 可数份数（"两个"→2），展示用不算账；null=纯重量/旧记录，退回克数
  count_unit: string | null; // 量词（个/碗/片/根）
  raw_input: string | null; // 数据留痕，不再作主显示（T52 前曾为主显示）
  weight_g: number;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  is_estimated: boolean;
  portion_label: string;
};

export type MealCardLastChange = { record_id: string; prev_state?: UndoPrevState };

export type MealCardPayload = {
  meal_key: { date: string; meal_type: string };
  // T53：项级撤销——按 record_id 存多条，批量改的每条各自独立可撤销。
  // last_change 是 T53 前的单槽形态，历史卡兼容读（见 meal-card.tsx 归一）。
  last_changes?: MealCardLastChange[];
  last_change?: MealCardLastChange | null;
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
