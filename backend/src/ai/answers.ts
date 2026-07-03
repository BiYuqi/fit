import { callDeepSeekCtx } from "./ctx";
import type { MemoryPack, RecordRef } from "../services/memory";
import { recordTokenUsage } from "../services/token";

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

// T39：面向用户的三类文字回复升级为 pro（解析/parse 不动，仍 flash 主力）。
// 这三类调用频次远低于 parse、质量敏感，成本可控（token 按 purpose 分桶记账）。
const ANSWER_MODEL = "deepseek-v4-pro";

// 三个回答函数共享的人设基底：铁律 1（AI 绝不算账）+ 只读路径禁止谎称操作
// （2026-07-03 真实案例：discuss 回复"已更新【葱花饼】热力为180kcal"，数据库根本没动，下一轮当场穿帮）。
const PERSONA_BASE = `你是一名专业但不说教的减脂教练，用简洁自然的中文回复：默认不超过3句话，说人话，用户追问再展开，别写小作文。
铁律：所有数字只能引用【当前对话上下文】里已经给出的数据（今日进度/近3日/本周本月/记录详情等），绝不自己计算或推算热量、营养、消耗——这些账只能由后端按食物库/公式算好放进上下文，你只负责引用和解释。
你是只读的：绝不能说"已记录/已更新/已修改/已删除"这类话，因为你没有改动任何数据。上下文里没有覆盖的数据要如实说"没有这条记录"/"这天没记录"，不能编造或估算凑数。用户想改数据时，引导 TA 用能触发真正修改的说法（如"改成X克"、"删掉那条"、"记成X千卡"）。`;

export async function answerQuery(question: string, pack: MemoryPack, userId: string, extraCtx?: string): Promise<{
  text: string;
  usage: Usage;
}> {
  const { res } = await callDeepSeekCtx(
    pack,
    [
      {
        role: "system",
        content: `${PERSONA_BASE}

你的职责：根据上下文里的【今日进度】【近3日每日摄入】【本周】【本月】（或下面追加的【实时查询】结果）回答用户问的汇总类数据问题。问到的日期没有数据覆盖时，明确说"这天没有记录"，不要编造数字。${extraCtx ? `\n\n${extraCtx}` : ""}`,
      },
      { role: "user", content: question },
    ],
    { model: ANSWER_MODEL },
  );
  const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  await recordTokenUsage({
    userId,
    model: ANSWER_MODEL,
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
        content: `${PERSONA_BASE}

你的职责：回答饮食/营养/运动/减脂/体重管理相关的问题，或结合上下文里的【今日进度】【本周】给建议（引用真实数字，不编造）。
与这些主题完全无关的问题（编程、时事、娱乐等）礼貌拒答，固定回复：「这个问题超出我的服务范围啦～我只能帮你解答饮食、营养和运动相关的问题，有减脂方面的疑问随时告诉我 💪」

示例（理解意图即可，不要照抄用词）：
- 用户："帮我算算一碗牛肉面大概多少大卡" → 不要自己估算数字，引导用户直接说"中午吃了一碗牛肉面"来记录，由系统按食物库算账。
- 用户："记录成180kcal"/"帮我把那条删了"（这句话本身没有真正触发修改）→ 绝不说"已更新/已删除"，而是引导用户换一种能被识别为修改指令的说法。`,
      },
      { role: "user", content: text },
    ],
    { model: ANSWER_MODEL },
  );
  const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  await recordTokenUsage({
    userId,
    model: ANSWER_MODEL,
    purpose: "chat",
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  });
  return {
    text: res.choices[0]?.message?.content ?? "我没太明白，能换个说法吗？",
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
  let role: string;

  if (isExercise) {
    detail = `【被询问的记录】\n- 运动类型：${target.name}\n- 时长：${target.duration_min ?? "?"}分钟\n- 消耗热量：${target.calories}kcal`;
    role = `用户对某条运动记录提出了疑问，请结合上面的记录详情，解释这条记录是如何产生的（基于 MET 值 × 体重 × 时长的热量估算）。若用户觉得时长或消耗不准确，告知可以说"改成X分钟"或"改成X卡"来调整——但你自己不要动手改，也不要说"已经改好了"。`;
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
    role = `用户对某条饮食记录提出了疑问，请结合上面的记录详情，解释这条记录是如何产生的（份量估算依据、克数来源、热量算法）。若详情里有"AI 原估克数"一行，须如实说明克数经过了基于用户历史纠正习惯的系统自动校准，不要编造其他理由。若用户觉得克数不准，告知可以说"改成X克"来调整——但你自己不要动手改，也不要说"已经改好了/已更新"。`;
  }

  const { res } = await callDeepSeekCtx(
    pack,
    [
      {
        role: "system",
        content: `${PERSONA_BASE}

你的职责：${role}

${detail}`,
      },
      { role: "user", content: question },
    ],
    { model: ANSWER_MODEL },
  );
  const usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  await recordTokenUsage({
    userId,
    model: ANSWER_MODEL,
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
