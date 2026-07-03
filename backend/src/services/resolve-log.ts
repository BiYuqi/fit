// T37 双向记忆：卡片点选也是一轮对话。
// /pending/:id/resolve 各分支用这里的纯函数构建 ai_parse_log 行，
// 让「候选卡选了煎饼果子」「份量卡选了中份」「确认删除」进入 L0 对话窗口，
// 下一轮"再来一份"才有指代对象。纯函数抽出便于单测（不碰 prisma）。
// 铁律 3 合规：写入的是 ai_parse_log（AI 层事实），不是 chat_message。

export const CARD_INPUT_TEXT = "[点选卡片]";

const PORTION_ZH: Record<string, string> = {
  small: "小份",
  medium: "中份",
  large: "大份",
  custom: "自定",
};

export type ResolveAction =
  | { action: "portion_choice"; food_name: string; portion_label: string; grams: number }
  | { action: "food_choice"; food_name: string }
  | { action: "delete_confirm"; name: string; record_id: string; kind: string };

export interface ResolveLogData {
  user_id: string;
  input_text: string;
  intent: "resolve";
  status: "resolved";
  parsed_json: object;
  reply_summary: string;
}

// T38：chat.ts 文字回答路径复用这段文案生成撰写 reply，不必落一条多余的 ai_parse_log 就能拿到摘要。
export function describeResolveAction(act: ResolveAction): string {
  switch (act.action) {
    case "portion_choice":
      return `确认：${act.food_name} ${PORTION_ZH[act.portion_label] ?? act.portion_label} ${Math.round(act.grams)}g`;
    case "food_choice":
      return `已选「${act.food_name}」，待确认份量`;
    case "delete_confirm":
      return `已删除：${act.name}`;
  }
}

export function buildResolveLogData(user_id: string, act: ResolveAction): ResolveLogData {
  return {
    user_id,
    input_text: CARD_INPUT_TEXT,
    intent: "resolve",
    status: "resolved",
    parsed_json: act as object,
    reply_summary: describeResolveAction(act),
  };
}
