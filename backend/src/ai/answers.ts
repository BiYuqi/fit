import { callDeepSeekCtx } from "./ctx";
import type { MemoryPack, RecordRef } from "../services/memory";
import { recordTokenUsage } from "../services/token";

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export async function answerQuery(question: string, pack: MemoryPack, userId: string, extraCtx?: string): Promise<{
  text: string;
  usage: Usage;
}> {
  const { res } = await callDeepSeekCtx(
    pack,
    [
      {
        role: "system",
        content: `你是减脂助手，根据上下文（今日进度、近3日记录、本周/月均值等）回答问题，数字来自上下文，回答简洁中文。${extraCtx ? `\n\n${extraCtx}` : ""}`,
      },
      { role: "user", content: question },
    ],
    { model: "deepseek-v4-flash" },
  );
  const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  await recordTokenUsage({
    userId,
    model: "deepseek-v4-flash",
    purpose: "query",
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  });
  return {
    text: res.choices[0]?.message?.content ?? "暂时无法回答",
    usage,
  };
}

export async function answerChat(text: string, pack: MemoryPack, userId: string): Promise<{
  text: string;
  usage: Usage;
}> {
  const { res } = await callDeepSeekCtx(
    pack,
    [
      {
        role: "system",
        content: `你是一个减脂健康助手，根据上下文（用户档案/今日记录/对话历史）回答问题，回答简洁，使用中文。
只回答与饮食、营养、运动、减脂、体重管理相关的问题。
如果用户的问题与以上主题完全无关（如编程、娱乐、时事等），请礼貌拒绝，回复：「这个问题超出我的服务范围啦～我只能帮你解答饮食、营养和运动相关的问题，有减脂方面的疑问随时告诉我 💪」`,
      },
      { role: "user", content: text },
    ],
    { model: "deepseek-v4-flash" },
  );
  const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  await recordTokenUsage({
    userId,
    model: "deepseek-v4-flash",
    purpose: "chat",
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  });
  return {
    text: res.choices[0]?.message?.content ?? "好的",
    usage,
  };
}

export async function answerDiscuss(
  question: string,
  target: RecordRef,
  fullRecord: { portion_label: string; food_confidence: number; portion_confidence: number; raw_input: string | null; predicted_grams?: number | null; food: { name: string; calories_100g: unknown } | null } | null,
  pack: MemoryPack,
  userId: string,
): Promise<{
  text: string;
  usage: Usage;
}> {
  const isExercise = target.kind === "exercise";

  let detail: string;
  let systemPrompt: string;

  if (isExercise) {
    detail = `【被询问的记录】\n- 运动类型：${target.name}\n- 时长：${target.duration_min ?? "?"}分钟\n- 消耗热量：${target.calories}kcal`;
    systemPrompt = `你是减脂助手。用户对某条运动记录提出了疑问，请结合以下记录详情，简洁中文解释这条运动记录是如何产生的（基于 MET 值 × 体重 × 时长的热量估算）。若用户觉得时长或消耗不准确，告知可以说"改成X分钟"或"改成X卡"来调整。\n\n${detail}`;
  } else {
    const PORTION_ZH: Record<string, string> = { small: "小份", medium: "中份", large: "大份", custom: "自定" };
    detail = `【被询问的记录】\n- 食物：${target.name}\n- 克数：${target.weight_g}g（${PORTION_ZH[target.portion ?? ""] ?? target.portion ?? "?"}份）\n- 热量：${target.calories}kcal`;
    if (fullRecord) {
      if (fullRecord.raw_input) detail += `\n- 用户原话："${fullRecord.raw_input}"`;
      detail += `\n- AI置信度：食物 ${fullRecord.food_confidence?.toFixed(2)}，份量 ${fullRecord.portion_confidence?.toFixed(2)}`;
      if (fullRecord.food) {
        detail += `\n- 食物库：${fullRecord.food.name} 每100g ${Math.round(Number(fullRecord.food.calories_100g))}kcal`;
      }
      // 偏差校准说明（LEARNING_SPEC §7，T31）：后端调过克数而 AI 不知情会编造错误解释
      if (
        fullRecord.predicted_grams != null &&
        target.weight_g != null &&
        Math.round(fullRecord.predicted_grams) !== Math.round(target.weight_g)
      ) {
        detail += `\n- AI 原估克数：${Math.round(fullRecord.predicted_grams)}g；当前 ${target.weight_g}g 的差异来自系统按该用户历史份量纠正习惯做的自动校准（或用户后续修改）`;
      }
    }
    systemPrompt = `你是减脂助手。用户对某条饮食记录提出了疑问，请结合以下记录详情，简洁中文解释这条记录是如何产生的（份量估算依据、克数来源、热量算法）。若详情里有"AI 原估克数"一行，须如实说明克数经过了基于用户历史纠正习惯的系统自动校准，不要编造其他理由。若用户觉得克数不准，告知可以说"改成X克"来调整。\n\n${detail}`;
  }

  const { res } = await callDeepSeekCtx(
    pack,
    [
      {
        role: "system",
        content: systemPrompt,
      },
      { role: "user", content: question },
    ],
    { model: "deepseek-v4-flash" },
  );
  const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  await recordTokenUsage({
    userId,
    model: "deepseek-v4-flash",
    purpose: "discuss",
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  });
  return {
    text: res.choices[0]?.message?.content ?? "我来解释一下这条记录的来由…",
    usage,
  };
}
