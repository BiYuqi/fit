// ────────────────────────────────────────────────────────────
// Token 用量记录 — 计费数据源
//
// 与 AiTrace 职责分离：
//   AiTrace.token_usage  — 调试：这次请求烧了多少 token，跟 trace 一起清理
//   TokenUsage            — 计费：用户这个月用了多少，长期保留
//
// 记录时机：每次 DeepSeek API 调用返回后立即写入，不受 DISABLE_AI_TRACE 影响。
// 写入失败静默忽略，不阻塞主流程。
// ────────────────────────────────────────────────────────────

import { prisma } from "../lib/prisma";

export async function recordTokenUsage(params: {
  userId: string;
  model: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  traceId?: string;
}): Promise<void> {
  try {
    await prisma.tokenUsage.create({
      data: {
        user_id: params.userId,
        model: params.model,
        purpose: params.purpose,
        prompt_tokens: params.promptTokens,
        completion_tokens: params.completionTokens,
        total_tokens: params.totalTokens,
        trace_id: params.traceId,
      },
    });
  } catch {
    // 计费记录失败不阻塞主流程
  }
}
