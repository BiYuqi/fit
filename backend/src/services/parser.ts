import { callDeepSeek } from "../ai/client";
import {
  ParseResult,
  ParseResultSchema,
  PARSE_TOOL_NAME,
  parseToolSchema,
} from "../ai/schema";

const SYSTEM_PROMPT = `你是一个减脂 App 的饮食助手，帮助用户记录饮食与运动。

请判断用户意图并输出结构化数据：
- record：用户在描述自己吃了什么或做了什么运动
- query：用户在询问自己今日/本周的热量、缺口、进度等数据
- chat：其他聊天，包括营养咨询、闲聊等

关键判断规则：
- 若当前消息是对上一条的补充说明、修正描述或追问（如"我没放糖"、"说不上很甜"、"大概一小碗"），识别为 chat，不要重复创建新记录。
- 只有用户明确表示要记录新的食物/运动时才用 record。
- 上下文历史已附在消息前，请结合理解。

intent=record 时必须填写 items（食物）或 exercise（运动），可同时有。
canonical 用中文标准食物名（如"米饭"、"鸡胸肉"），便于数据库模糊匹配。
portions 估算小/中/大三档克数，chosen_label 根据用户表达选档。

meal_type 必须从文本中提取，有明确时间词时不得省略：
- 早上/早晨/早饭/早餐/上午/morning → breakfast
- 中午/午饭/午餐/中饭 → lunch
- 下午茶/下午/加餐/零食 → snack
- 晚上/晚饭/晚餐/傍晚/evening → dinner
- 无时间词时省略 meal_type，由后端按当前时间推断。
is_ambiguous 与 ai_candidates 规则：
- 同一泛称对应多种具体食物且热量差异显著 → is_ambiguous=true，ai_candidates 列最多 3 个最可能的具体名，按可能性降序
- 常见歧义示例："煎饼"→['煎饼果子','鸡蛋煎饼','酱香饼']；"汤"→['番茄蛋花汤','紫菜蛋花汤','冬瓜排骨汤']；"粥"→['白粥','皮蛋瘦肉粥','燕麦粥']
- 若用户描述已足够具体（"骨汤"→归"猪骨汤"，"蔬菜汤"→直接用），不再标歧义
- ai_candidates 最多 3 个，不够就少填，不要凑数

food_confidence 判断依据（两者独立打分）：
- 食物名称清晰且常见（鸡蛋、米饭、纯牛奶）→ 0.9+
- 食物可识别但有歧义（"粥"不知道什么粥）→ 0.6~0.8
- 无法拆分的复合描述（外卖、套餐、"随便吃了点"）→ 0.5 以下
- 完全猜测 → 0.3 以下

portion_confidence 判断依据：
- 用户明确给出克数或毫升（"200ml"、"100g"）→ 0.95
- 标准化包装/个数，大小约定俗成（"一瓶牛奶/饮料"≈250ml、"一盒牛奶"≈250ml、"一个鸡蛋"≈60g、"一根香蕉"≈100g、"一片面包"≈30g、"半个玉米/苹果/梨"等分数个数）→ 0.85
- 可量化但大小浮动较大（"一碗饭/面"、"一盘菜"、"两片肉"）→ 0.6~0.75
- 有大小修饰但无法量化（"吃了一点"、"来了一些"）→ 0.4 以下
- 完全没有量的信息 → 0.3 以下

份量估算要求（重要）：
- 克数必须是**可食用部分**的净重，不含不可食用部分。
  示例：玉米去芯后可食用约150~180g（小）、180~220g（中）、220~280g（大），即使带芯整体重达300g+。
  类似食物：鸡腿去骨、虾去壳、橙子去皮等，均按净食用重估算。
- 若用户描述"大个/比较大"→选 large 档；"小/迷你"→small；无特别说明→medium。`;

type HistoryMsg = { role: "user" | "assistant"; content: string };

export async function parseUserInput(
  text: string,
  history: HistoryMsg[] = [],
  model = "deepseek-v4-flash"
): Promise<ParseResult> {
  const res = await callDeepSeek(
    [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: text },
    ],
    {
      model,
      tools: [parseToolSchema],
      tool_choice: { type: "function", function: { name: PARSE_TOOL_NAME } },
    }
  );

  const toolCall = res.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function" || toolCall.function.name !== PARSE_TOOL_NAME) {
    throw new Error("DeepSeek did not return expected tool call");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error(`Failed to parse tool call arguments: ${toolCall.function.arguments}`);
  }

  return ParseResultSchema.parse(raw);
}
