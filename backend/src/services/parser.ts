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

intent=record 时必须填写 items（食物）或 exercise（运动），可同时有。
canonical 用中文标准食物名（如"米饭"、"鸡胸肉"），便于数据库模糊匹配。
portions 估算小/中/大三档克数，chosen_label 根据用户表达选档。
置信度：食物明确→0.9+；表达模糊→0.5~0.8；猜测→0.5以下。`;

export async function parseUserInput(
  text: string,
  model = "deepseek-v4-flash"
): Promise<ParseResult> {
  const res = await callDeepSeek(
    [
      { role: "system", content: SYSTEM_PROMPT },
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
