import "dotenv/config";
import OpenAI from "openai";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set");
  return new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
}

let _client: OpenAI | null = null;
function getClient() {
  if (!_client) _client = buildClient();
  return _client;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface CallOptions {
  model?: string;
  tools?: OpenAI.Chat.ChatCompletionTool[];
  tool_choice?: OpenAI.Chat.ChatCompletionToolChoiceOption;
}

export async function callDeepSeek(
  messages: ChatMessage[],
  options: CallOptions = {}
): Promise<OpenAI.Chat.ChatCompletion> {
  const client = getClient();
  const model = options.model ?? "deepseek-v4-flash";
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // tool call 时关闭 thinking mode（thinking mode 不支持强制 tool_choice）
      const params: Record<string, unknown> = { model, messages };
      if (options.tools) {
        params.tools = options.tools;
        params.tool_choice = options.tool_choice;
        params.thinking = { type: "disabled" };
      }

      const res = await (client.chat.completions.create as unknown as (p: Record<string, unknown>) => Promise<OpenAI.Chat.ChatCompletion>)(params);

      const choice = res.choices[0];
      if (!choice) throw new Error("DeepSeek returned empty choices");
      return res;
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);

      if (retryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error("DeepSeek call failed after max retries");
}
