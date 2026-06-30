export type MessageKind =
  | 'text'
  | 'record_card'
  | 'portion_card'
  | 'candidate_card'
  | 'clarify_card'
  | 'query_card'
  | 'exercise_card';

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

export type RecordCardPayload = {
  food_name: string;
  weight_g: number;
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  is_estimated?: boolean;
};

export type PortionOption = { label: string; grams: number; calories?: number };

export type PortionCardPayload = {
  pending_id: string;
  food_name: string;
  portions: PortionOption[];
};

export type CandidateFood = {
  name: string;
  calorie_hint?: number; // 默认中份热量提示，DB 有记录时才有
};

export type CandidateCardPayload = {
  pending_id: string;
  query: string;
  foods: CandidateFood[];
};

export type ClarifyCardPayload = {
  pending_id: string;
  query: string;
  portions?: PortionOption[];
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
};

export type SendMessageResponse = {
  intent: 'record' | 'query' | 'chat';
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
