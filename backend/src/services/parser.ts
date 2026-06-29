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
置信度：食物明确→0.9+；表达模糊→0.5~0.8；猜测→0.5以下。

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
