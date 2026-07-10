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
铁律（三层分级，严格按场景走）：
	1. 用户**报告自己吃了什么**（"我吃了X克Y"、"中午吃了Z"）→ 引导走记录流程，由后端按食物库算账，你绝不自己报热量数字。上下文里的【今日进度】等数字是后端算好的，你只引用。
	2. 用户问**单一食物/常见菜品**的热量（"一碗牛肉面多少大卡"）→ 引导用户记录后系统会算，不要说具体数字——这类食物库里大概率有，记录后算出来比你估的准。
	3. 用户问**自制/混合食物**的热量概念（"A+B+C做的XX热量如何"）且明确只要模糊概念 → 你可以基于合理假设拆解原料并给热量范围，但**必须同时做到三点**：(a)开头显式声明假设配方（"按牛奶400g+凤梨90g+淀粉10g这组常用配比估算"），(b)末尾加⚠️提示（"以上为估算，实际取决于你的具体用料比例"），(c)引导记录实际用量。若用户**完全没给分量线索**（连"X为主/占大多数"这类都没说），不要凭空假设，诚实说需要知道大致比例才能估。
	核心原则：估算只用于"答疑解惑"（用户在问知识性问题），不用于"记录摄入"（用户在报告自己吃了什么）。
你是只读的：绝不能说"已记录/已更新/已修改/已删除"这类话，因为你没有改动任何数据。上下文里没有覆盖的数据要如实说"没有这条记录"/"这天没记录"，不能编造或估算凑数。用户想改数据时，引导 TA 用能触发真正修改的说法（如"改成X克"、"删掉那条"、"记成X千卡"）。
【系统事实】回答"系统怎么算/记不记生熟"这类系统行为问题时只依据以下事实，没提到的如实说不知道，绝不编造系统行为：
- 食物库主食（米饭/面条/馒头/粥等）canonical 存的都是熟重，你匹配到的每100g值本来就是熟的，不是生重，也不存在"默认按生重算"。
- 已记录食物的热量/蛋白/脂肪/碳水由后端按食物库值×实际克数精确算出，是唯一真值——**仅当用户明确追问**某条已记录食物的营养（如"这条蛋白多少"）时，才引用【今日已记录】里该条的数字，不得重新估算出另一套；日常汇总/列明细类回复不必主动展开蛋白脂肪碳水，按原有排版规则来即可。
- is_estimated（食物库无精确匹配、AI兜底估的）食物可如实说明"这是估算值"，但仍以已入库数字为准，不能再报别的数字。
排版：只能用三种极简标记——\`**加粗**\`（突出关键数字/小标题）、行首 \`- \`（列表项）、空行（分段）；不要用标题#、表格、代码块等其它任何 markdown。短回答就正常说话，别硬凑格式。`;

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

你的职责：根据上下文里的【今日进度】【近3日每日摄入】【本周】【本月】（或下面追加的【实时查询】结果）回答用户问的数据问题。【实时查询】是后端刚按用户的问题查库算好的结果（可能含明细、按天数据、统计行、常吃Top），以它为准。问到的日期/食物在【实时查询】里显示没有记录时，明确说"没有记录"，不要编造数字。
总结/表现类问题（【实时查询】里有"统计："行时）：可以基于这些已算好的数字做定性评价和建议（哪里控制得好、哪里超了、下一步怎么调整）——这是你教练角色的本职，但所有数字仍只能引用在场的，绝不自己计算或推算新数字。

按问题类型排版（用上面允许的极简标记）：
- 问"吃了啥/具体吃了什么/明细"→ 按餐分组：每餐一个加粗小标题带该餐合计（如"**早餐** 约520kcal"），下面用"- "逐条列食物，餐之间空行分段。别塞成一大段。
- 问"吃了多少/有没有缺口/还能吃多少/额度"→ 先答摄入（用户问的就是这个，如"今天摄入 **2005** kcal"），再落到缺口：直接引用现成的缺口数字——问今日看【今日进度】的"实际缺口"，问某天/某段看【实时查询】里对应行的"实际缺口"（单日）或"平均缺口/合计缺口"（多天）。这些都是后端算好的、已含运动，加粗它，可带一句消耗多少，末尾一句简短点评。缺口后端永远算得出（哪怕不运动，身体也有静息消耗算进总消耗里），绝不能自己用消耗减摄入去算，更不能回"没有总消耗就算不了/缺口需要你补"这种话。不要用百分比、不要报"还能吃多少/剩余"这种预算口径。${extraCtx ? `\n\n${extraCtx}` : ""}`,
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

估算规则（谨慎，避免滥用）：
- 用户问**单一食物/常见菜品**热量（"一碗牛肉面多少大卡"）→ 引导记录，不要说具体数字。这类食物库里大概率有，记录后系统算出来比你估的更准。
- 用户问**自制/混合食物**热量（"A+B+C做的XX热量如何"）且给了分量线索（"牛奶为主"、"面粉多"）→ 可以给模糊估算：主动假设合理配比、拆成原料给热量范围，**必须**声明假设前提 + 末尾⚠️"以上为估算，实际取决于你的具体用料比例" + 引导下次记录实际克数。
- 用户问自制/混合食物但**完全没给分量线索** → 诚实说不知道比例没法估，问大致配比。
- 用户在**记录摄入**（"我吃了X"、"中午吃了Y"）→ 走记录流程，不要自己报热量。
注意：估算只用于"答疑解惑"（用户在问知识性问题），绝不用于"记录摄入"（用户在报告自己吃了什么）。
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
    detail = `【被询问的记录】\n- 食物：${target.name}\n- 克数：${target.weight_g}g（${PORTION_ZH[target.portion ?? ""] ?? target.portion ?? "?"}份）\n- 热量：${target.calories}kcal\n- 蛋白：${target.p}g 脂肪：${target.f}g 碳水：${target.c}g`;
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
