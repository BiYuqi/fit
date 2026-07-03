import type { ChatTrace } from "../trace";
import type { MemoryPack } from "../memory";

export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export interface IntentCtx {
  user_id: string;
  text: string;
  source: string;
  today: string;
  dateObj: Date;
  pack: MemoryPack;
  messages: object[];
  tctx: ChatTrace;
  parseUsage?: Usage;
  parseMessages?: object;
  parseLogId?: string; // 本轮 ai_parse_log 主键（resolve_pending 回填 intent/parsed_json 用，见 intents/resolve-pending.ts）
}
