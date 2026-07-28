// Memory Extractor — 语义记忆提取管线（MEMORY_SPEC §4）
// 双层触发：同步 constraint（关键词 → LLM → 写入，零窗口期）
//         + 异步 full（响应返回后跑，不阻塞主流程）
//
// LLM 只提取事实，不评分——Scoring Engine 负责决策。

import { z } from "zod";
import { callDeepSeek } from "../ai/client";
import { prisma } from "../lib/prisma";
import {
  upsertMemory,
  invalidateMemory,
  loadActiveMemories,
  type ActiveMemory,
  type MemoryGroups,
} from "./memory-store";

// ── 关键词预筛选词表（MEMORY_SPEC §4.2）──

/** 约束关键词：同步路径第一层过滤，命中才调 LLM（~50 词，< 0.1ms） */
/** 用户特征信号词：同步路径第一层过滤，命中才调 LLM。
 *  宁可松不可紧——漏筛代价是少记一条用户特征，LLM 才是真正的闸门。 */
export const CONSTRAINT_KEYWORDS = [
  // 过敏
  "过敏", "过敏源", "起疹子", "起红疹", "肿了", "呼吸困难",
  "碰不得", "不能碰", "不能吃", "不能喝", "忌口", "忌",
  // 疾病/医疗（笼统 + 具体，覆盖面优先）
  "痛风", "糖尿病", "血糖", "血压", "高血脂", "脂肪肝",
  "乳糖不耐", "麸质", "胃酸", "胃病", "胃痛", "胃胀", "胃炎", "胃溃疡", "肠胃",
  "腹泻", "拉肚子", "便秘", "消化不良",
  "肾病", "肝病", "胆囊", "结石", "心脏", "甲亢", "甲减", "贫血",
  "怀孕", "哺乳",
  "医生说", "营养师说", "体检", "报告", "查出", "诊断", "得了", "患有",
  // 饮食身份/限制
  "素食", "吃素", "清真", "halal", "不吃猪肉", "不吃肉",
  // 偏好/习惯（口语化表达——用户可能在描述自己）
  "不吃", "讨厌", "喜欢", "爱吃", "受不了", "接受不了", "从来不吃",
  "习惯", "一般", "通常", "总是", "每天", "一直",
  // 状态/目标信号
  "最近", "这周", "这个月", "备赛", "出差", "控碳", "戒", "减肥", "增肌",
  "压力", "焦虑", "加班", "熬夜", "生病", "不舒服",
  // 显式记忆请求 + 生熟表达（T59）
  "记住", "别忘了", "记下", "以后都", "下次都", "生重", "熟重", "熟的",
];

/** 否认/结束信号词（T74）：作废通道的预筛选。
 *
 *  上面那张表全是"用户在**陈述**一个事实"的信号，而否认长成另一个样子——
 *  「我排便正常了，你是不是记错了」一个词都不命中，quickExtract 根本不会被调起，
 *  作废通道就永远等不到输入。这是 T74 真机验收第 1 条挂掉的直接原因。 */
export const DENIAL_KEYWORDS = [
  // 指出记忆错了
  "记错", "搞错", "错了", "不对", "没有说", "我没说", "谁说",
  // 状态已结束
  "正常了", "好了", "痊愈", "康复", "不再", "已经不", "现在不", "早就",
  "回来了", "结束了", "过去了", "停了", "戒掉了",
];

/** 异步 full 提取触发词：比约束词表宽，宁可松不可紧 */
const FULL_TRIGGERS = [
  ...CONSTRAINT_KEYWORDS,
  ...DENIAL_KEYWORDS,
  // 偏好/口味
  "不吃", "讨厌", "喜欢", "爱吃", "习惯", "一般", "通常", "总是",
  // 阶段性状态/目标
  "最近在", "最近", "这周", "这个月", "备赛", "出差", "控碳", "戒", "少油", "少盐",
  "减肥", "增肌", "控糖", "生酮", "断食", "轻断食", "低碳",
  // 临时状态
  "压力", "焦虑", "加班", "熬夜", "生病", "不舒服", "旅游", "放假", "过年", "夜班",
];

// ── LLM 输出 Zod Schema ──

const MEMORY_TYPES = [
  "constraint",
  "preference",
  "habit",
  "context_state",
  "goal",
] as const;

const MemoryCandidateSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  entity: z.string().min(1),
  content: z.string().min(1),
  llm_confidence: z.number().min(0).max(1),
  importance_class: z.enum(["medical", "strong", "normal", "casual"]),
  source: z.string(),
  expires_at: z.string().nullable().optional(),
});

/** 作废通道（T74）：指向一条已有记忆，不携带 content——形状和"创建"根本不同，
 *  塞进 candidates 会让两组字段互相 optional，模型更容易填错。 */
const InvalidationSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  entity: z.string().min(1),
  reason: z.string(),
  llm_confidence: z.number().min(0).max(1),
});

type Invalidation = z.infer<typeof InvalidationSchema>;

const ExtractResultSchema = z.object({
  candidates: z.array(MemoryCandidateSchema).default([]),
  invalidations: z.array(InvalidationSchema).default([]),
});

// ── LLM Prompts ──

/**
 * 作废通道说明（T74）——**同步和异步两份 prompt 共用这一段文本**。
 * 拆成常量是刻意的：QUICK/FULL 是两份独立 prompt，历史上改一份忘另一份出过
 * "异步能作废、同步不能"的不一致（见 t59 的教训）。作废规则只有这一处定义。
 */
const INVALIDATION_SECTION = `
## 作废已有记忆
用户可能在否认下方【已有记忆】里的某一条，或宣告某个状态已经结束。这时把它放进 invalidations。

触发信号：
- 直接否认："我排便正常了"、"你是不是记错了"、"早就好了"、"我没有不吃香菜"
- 状态结束："出差回来了"、"备赛结束了"、"感冒好了"

硬规则：
1. entity **必须逐字来自下方【已有记忆】列表**，列表里没有的一律不输出——宁可漏一条，不许现编。
2. 医疗类记忆（过敏/诊断/疾病）用户否认时也照常放进 invalidations——系统只会降权不会删除，不用你替它把关。
3. 同一句话可以**既作废又创建**——两个数组都填，不要二选一。
4. llm_confidence 按否认的明确程度给：明确否认 0.90+，含糊 0.70-0.85。

例子（【已有记忆】里有 [context_state] recent_constipation 和 [context_state] no_aerobic_exercise 时）：
- "我排便正常了，你是不是记错了" → invalidations:[{"type":"context_state","entity":"recent_constipation","reason":"我排便正常了","llm_confidence":0.95}]，candidates:[]
- "我每天都有30分钟的羽毛球" → invalidations:[{"type":"context_state","entity":"no_aerobic_exercise","reason":"我每天都有30分钟的羽毛球","llm_confidence":0.92}]，**同时** candidates:[{"type":"habit","entity":"daily_badminton_30min","content":"每天30分钟羽毛球","llm_confidence":0.90,"importance_class":"normal","source":"我每天都有30分钟的羽毛球"}]`;

/**
 * 约束提取 prompt：极轻量（~80 token），只提取 constraint 类型。
 * 不包含其他四类的定义——预筛选已过滤了大部分无关消息。
 */
const QUICK_EXTRACT_PROMPT = `你是记忆提取器。用户正在告诉你关于 ta 自己的事情——你的任务是记住。

提取所有五类用户特征（不要只盯着 constraint）：

### constraint（硬约束——安全/健康相关）
- 过敏、诊断、疾病："花生过敏"、"慢性非萎缩性胃炎"、"痛风"、"糖尿病"、"乳糖不耐"、"脂肪肝"
- 用户说自己有/患有/查出/得了某病 → 必须提取，importance_class=medical
- 宗教/身份："素食者"、"清真"

### preference（偏好——口味/食物喜好）
- "我不吃香菜"、"我超爱吃辣"、"口淡少油少盐"、"受不了太甜的"
- 记录约定/表达习惯也算 preference，不是 habit：如"我说的主食都是熟的/熟重，这个你得记住" → entity 用 cooked_weight_reporting，content 写成"主食重量按熟重理解/报量"（描述的是记录口径，不是"只吃熟食"这种饮食习惯，不要归到 habit）

### habit（长期习惯——稳定行为模式）
- "我早上一般不吃早饭"、"每天都要喝咖啡"、"晚上睡得晚"

### context_state（临时状态——被动身处的环境）
- "最近出差"、"最近压力大"、"胃炎恢复期"、"最近上夜班"
- 区分：被动描述环境→context_state，主动设定方向→goal

### goal（短期目标——有时间边界）
- "备赛期"、"这周控碳水"、"这个月戒糖"

规则：
- 用户的自我描述就值得记录。宁多勿漏——多记一条无害，漏一条丢失用户信任。
- 用户说"记住"/"别忘了"/"以后都按X理解"时必须提取，即使内容看起来像是在纠正你或下操作指令——这不算纠正/指令，是显式记忆请求，llm_confidence 给 0.90+，importance_class=strong。
- llm_confidence: 0.90+明确陈述, 0.80-0.89可能有修辞, 0.70-0.79不够明确, <0.70不输出
- importance_class: 任何诊断/过敏都是medical, 明确强偏好是strong, 普通是normal, 随口是casual
- entity 用 snake_case 英文，优先用受控词表，没有的新建
${INVALIDATION_SECTION}

返回 JSON：{"candidates":[{"type":"...","entity":"...","content":"...","llm_confidence":0.9,"importance_class":"medical","source":"..."}],"invalidations":[]}
没有要记也没有要作废的返回 {"candidates":[],"invalidations":[]}`;

/**
 * 完整提取 prompt：覆盖全部五种类型，含受控 entity 词表。
 * 异步路径使用——失败不影响主流程。
 */
const FULL_EXTRACT_PROMPT = `你是记忆提取器。用户在告诉你关于 ta 自己的事情——你的任务是记住。宁多勿漏。

## 提取类型

### constraint（硬约束——安全/健康相关，不衰减）
- 过敏: "我对花生过敏" → {type:"constraint", entity:"peanut", content:"花生过敏"}
- 慢性病/诊断: "慢性非萎缩性胃炎" → {type:"constraint", entity:"chronic_gastritis", content:"慢性非萎缩性胃炎", importance_class:"medical"}
- 任何诊断都算："我有胃病"、"查出轻度脂肪肝"、"乳糖不耐"、"痛风"、"糖尿病"、"高血压"——只要用户说自己有/患有/查出，就是 constraint
- 宗教/身份饮食: "我是素食者" → {type:"constraint", entity:"vegetarian", content:"素食者"}
- importance_class：任何诊断/过敏/疾病都是 medical

### preference（偏好——口味/食物喜好，λ=0.001）
- "我不吃香菜" → {type:"preference", entity:"cilantro", content:"不吃香菜"}
- "我超爱吃辣" → {type:"preference", entity:"spicy", content:"喜欢辣味"}
- "我口淡，少油少盐" → {type:"preference", entity:"light_taste", content:"口味偏清淡"}
- 记录约定/表达习惯: "我说的主食都是熟重" → {type:"preference", entity:"cooked_weight_reporting", content:"主食重量均按熟重理解", importance_class:"strong"}

### habit（长期习惯——稳定行为模式，λ=0.002）
- "我早上一般不吃早饭" → {type:"habit", entity:"skip_breakfast", content:"通常不吃早餐"}
- "我每天都要喝咖啡" → {type:"habit", entity:"coffee", content:"每天喝咖啡"}
- "我晚上睡得晚" → {type:"habit", entity:"late_sleeper", content:"晚睡"}

### context_state（临时状态——被动身处的环境，λ=0.005）
- "最近出差，吃饭不规律" → {type:"context_state", entity:"business_trip", content:"出差中，饮食不规律"}
- "最近工作压力大" → {type:"context_state", entity:"stress_period", content:"压力期，夜间食欲增加"}
- "最近胃炎，只能吃清淡的" → {type:"context_state", entity:"illness_recovery", content:"胃炎恢复期，需清淡饮食"}
区分 context_state vs goal：被动描述环境→context_state，主动设定方向→goal

### goal（短期目标——有时间边界，λ=0.02 + expires_at）
- "最近在备赛" → {type:"goal", entity:"competition_prep", content:"备赛期"}
- "这周控碳水" → {type:"goal", entity:"low_carb", content:"本周控制碳水摄入", expires_at:"2026-07-14"}
- "这个月戒糖" → {type:"goal", entity:"no_sugar", content:"本月戒糖", expires_at:"2026-07-31"}
区分 habit vs goal：有时间限定("这周"/"这个月")→goal，"一般"/"通常"/"总是"→habit。拿不准选habit

## 受控 Entity 词表（优先匹配，没有的才新建 snake_case）
cilantro(香菜), spicy(辣), peanut(花生), seafood(海鲜), dairy(乳制品), gluten(麸质), soybean(大豆), light_taste(口淡/清淡), sweet(甜食), skip_breakfast(不吃早饭), vegetarian(素食), halal(清真), alcohol(酒), coffee(咖啡), competition_prep(备赛), low_carb(控碳水), weight_loss(减肥), intermittent_fasting(断食), business_trip(出差), stress_period(压力), holiday_mode(节假日), illness_recovery(生病), night_shift(夜班), cooked_weight_reporting(熟重报量)

## 显式记忆请求（优先级高于下方"绝不提取"）
用户明确要求记住的内容必须提取——出现"记住"、"别忘了"、"以后都按X理解"、"下次都..."等信号时，即使内容表面上像是对 AI 的纠正或操作指令，也要作为记忆提取，不落入"绝不提取"的纠正/指令项。llm_confidence 按明确陈述给 0.90+，importance_class=strong。
- "我说的都是熟的饭，谁没事吃生的，这个你得记住" → {type:"preference", entity:"cooked_weight_reporting", content:"主食重量均按熟重理解", importance_class:"strong", llm_confidence:0.95}
- "以后份量都按我说的算，别自己估" → {type:"preference", entity:"trust_user_portion", content:"份量以用户自报为准，不要自行估算", importance_class:"strong", llm_confidence:0.95}

## 提取规则
1. llm_confidence ∈ [0,1]，<0.70 不输出
2. 句子主语是"我"（人）→ 可能提取；主语是"这个/那个"（食物/事情）→ 不提取
3. 不推断、不猜测、不脑补用户没说的话
4. entity 优先用上方受控词表，没有的才新建 snake_case 英文
5. importance_class: medical(安全/医疗), strong(重要偏好/强习惯), normal(普通), casual(随口)
6. expires_at 仅 type=goal 且用户给了时间限定时填写 ISO date，否则 null

## 绝不提取
- 单次食物评价("这个面太油了")
- 瞬时情绪/状态("今天好累")
- 假设/愿望("如果能戒掉宵夜就好了")
- 对 AI 的纠正——仅指未要求记住的单次纠正("你估太多了应该是100g")；若用户明确要求记住/以后都按此理解，按上方"显式记忆请求"规则提取，不适用此例外
- 操作指令("把牛肉面改成大份")
- 聊天寒暄("谢谢"、"哈哈")
- 引用他人("我朋友说碳水不好")
- 饮食记录本身("中午吃了一碗面")
${INVALIDATION_SECTION}

返回 JSON：{"candidates":[{...}],"invalidations":[{...}]}`;

// ── Helpers ──

/** 渲染【已有记忆】段落——去重用，也是作废通道的候选来源（entity 只能从这里挑） */
function renderExistingSection(memories: MemoryGroups): string {
  const summaries = [
    ...memories.constraints.map((m) => `[constraint] ${m.entity}: ${m.content}`),
    ...memories.contextGoals.map((m) => `[${m.type}] ${m.entity}: ${m.content}`),
    ...memories.prefsHabits.map((m) => `[${m.type}] ${m.entity}: ${m.content}`),
  ].slice(0, 10);

  if (summaries.length === 0) return "";
  return `\n## 已有记忆（去重 + 作废的唯一候选来源，最多10条）\n${summaries.join("\n")}`;
}

/** 从 LLM 文本回复中提取 JSON */
function extractJson(text: string): object | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ── Quick Extraction（同步，T55/T56）──

export interface QuickExtractResult {
  /** 本轮写入/更新的记忆（chat.ts 本轮立即可用） */
  memories: ActiveMemory[];
  /** 用户否认了但因为是医疗类而**只降权没作废**的记忆 content——供回复引导用户手动删 */
  medicalDenials: string[];
}

const EMPTY_QUICK: QuickExtractResult = { memories: [], medicalDenials: [] };

/**
 * 关键词命中 → 调 DeepSeek flash 提取所有五类用户特征 + 作废信号 → 写入 user_memory。
 *
 * 不再只提 constraint——用户说的任何关于自己的事实都值得记住。
 * 作废走同步路径（T74 口径 4）：用户说"你记错了"之后下一句就可能重问同一个问题，
 * 异步 fullExtract 在响应返回后才跑，会导致同一轮对话里 AI 再说一遍错话。
 *
 * 关键词未命中直接返回空，零 LLM 调用。LLM 调用失败静默返回空，不影响主流程。
 */
export async function quickExtract(
  text: string,
  userId: string,
): Promise<QuickExtractResult> {
  // 第一层：关键词预筛选（< 0.1ms）
  if (!hasMemorySignal(text)) return EMPTY_QUICK;

  try {
    // 作废必须知道有哪些记忆可作废——同步路径也要喂已有记忆（多一次 DB 查询，可接受）
    const activeMemories = await loadActiveMemories(userId);

    const res = await callDeepSeek(
      [
        {
          role: "system",
          content: QUICK_EXTRACT_PROMPT + renderExistingSection(activeMemories),
        },
        { role: "user", content: text },
      ],
      { model: "deepseek-v4-flash" },
    );

    const raw = res.choices[0]?.message?.content;
    if (!raw) return EMPTY_QUICK;

    const json = extractJson(raw);
    if (!json) return EMPTY_QUICK;

    const parsed = ExtractResultSchema.safeParse(json);
    if (!parsed.success) {
      console.warn("quickExtract: zod validation failed", parsed.error.flatten());
      return EMPTY_QUICK;
    }

    // 先作废后创建：同一句话里"作废旧的 + 新建同 entity 的"顺序反了会被自己刚建的行挡住
    const medicalDenials = await applyInvalidations(
      userId,
      parsed.data.invalidations,
      activeMemories,
      "quickExtract",
    );

    const memories: ActiveMemory[] = [];
    for (const c of parsed.data.candidates) {
      try {
        memories.push(
          await upsertMemory(userId, {
            type: c.type,
            entity: c.entity,
            content: c.content,
            llm_confidence: c.llm_confidence,
            importance_class: c.importance_class,
            source_text: c.source,
            expires_at: c.expires_at ? new Date(c.expires_at) : null,
          }),
        );
      } catch (err) {
        console.warn("quickExtract: upsert failed for", c.entity, err);
      }
    }
    return { memories, medicalDenials };
  } catch (err) {
    console.warn("quickExtract: LLM call failed", err);
    return EMPTY_QUICK;
  }
}

/**
 * 执行 invalidations，返回"因医疗类而只降权没作废"的记忆 content 列表。
 * 单条失败静默吞掉——记忆是增强不是主流程。
 */
async function applyInvalidations(
  userId: string,
  invalidations: Invalidation[],
  known: MemoryGroups,
  logPrefix: string,
): Promise<string[]> {
  if (invalidations.length === 0) return [];

  const all = [...known.constraints, ...known.contextGoals, ...known.prefsHabits];
  const medicalDenials: string[] = [];

  for (const inv of invalidations) {
    const target = all.find((m) => m.type === inv.type && m.entity === inv.entity);
    // 模型现编了一个不在列表里的 entity → 直接忽略，不去库里碰运气
    if (!target) {
      console.warn(`${logPrefix}: invalidation entity not in fed list, ignored`, inv.entity);
      continue;
    }
    try {
      const result = await invalidateMemory(userId, inv.type, inv.entity, {
        reason: inv.reason,
        llmConfidence: inv.llm_confidence,
      });
      if (result === "demoted" && target.importance_class === "medical") {
        medicalDenials.push(target.content);
      }
    } catch (err) {
      console.warn(`${logPrefix}: invalidate failed for`, inv.entity, err);
    }
  }
  return medicalDenials;
}

// ── Full Extraction（异步，MEMORY_SPEC §4.1 异步路径）──

/**
 * 取最近 5 轮用户消息 + 已有最近 10 条 memory 摘要 → 预筛选 → 调 DeepSeek flash
 * → 逐个送 Scoring Engine（via upsertMemory）→ 写入。
 *
 * 失败静默，不抛异常——异步提取是"赠品"，不应打断主流程。
 */
export async function fullExtract(userId: string): Promise<void> {
  try {
    // 1. 取最近 5 条用户消息
    const recentMessages = await prisma.chatMessage.findMany({
      where: { user_id: userId, role: "user" },
      orderBy: { created_at: "desc" },
      take: 5,
      select: { content: true },
    });

    if (recentMessages.length === 0) return;

    const combined = recentMessages.map((m) => m.content).join(" ");

    // 2. 预筛选：最近消息是否含任何记忆信号词
    const hit = FULL_TRIGGERS.some((kw) => combined.includes(kw));
    if (!hit) return;

    // 3. 取已有 ACTIVE 记忆摘要（去重 + 作废候选，最多 10 条）
    const activeMemories = await loadActiveMemories(userId);

    // 4. 组装 prompt：已有记忆摘要 + 最近用户消息
    const existingSection = renderExistingSection(activeMemories);

    const userMessages = recentMessages
      .reverse()
      .map((m) => m.content)
      .join("\n---\n");

    const res = await callDeepSeek(
      [
        { role: "system", content: FULL_EXTRACT_PROMPT + existingSection },
        { role: "user", content: `用户最近消息：\n${userMessages}` },
      ],
      { model: "deepseek-v4-flash" },
    );

    const raw = res.choices[0]?.message?.content;
    if (!raw) return;

    const json = extractJson(raw);
    if (!json) return;

    const parsed = ExtractResultSchema.safeParse(json);
    if (!parsed.success) {
      console.warn("fullExtract: zod validation failed", parsed.error.flatten());
      return;
    }

    // 5. 先作废后创建（同 quickExtract：顺序反了会被自己刚建的行挡住）
    await applyInvalidations(
      userId,
      parsed.data.invalidations,
      activeMemories,
      "fullExtract",
    );

    if (!parsed.data.candidates.length) return;

    // 6. 逐个写入（Scoring Engine 在 upsertMemory 内部调用）
    for (const c of parsed.data.candidates) {
      try {
        await upsertMemory(userId, {
          type: c.type,
          entity: c.entity,
          content: c.content,
          llm_confidence: c.llm_confidence,
          importance_class: c.importance_class,
          source_text: c.source,
          expires_at: c.expires_at ? new Date(c.expires_at) : null,
        });
      } catch (err) {
        console.warn("fullExtract: upsert failed for", c.entity, err);
      }
    }
  } catch (err) {
    // 异步提取失败不影响主流程——静默吞掉
    console.warn("fullExtract: failed", err);
  }
}

/** 文本是否含记忆信号——陈述（CONSTRAINT_KEYWORDS）或否认（DENIAL_KEYWORDS）。
 *  quickExtract 与 chat.ts 的同一道闸门，只有这一处定义。 */
export function hasMemorySignal(text: string): boolean {
  return (
    CONSTRAINT_KEYWORDS.some((kw) => text.includes(kw)) ||
    DENIAL_KEYWORDS.some((kw) => text.includes(kw))
  );
}
