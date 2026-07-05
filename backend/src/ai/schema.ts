import { z } from "zod";

// ---------- 枚举 ----------
export const IntentSchema = z.enum(["record", "query", "chat", "modify", "discuss", "resolve_pending", "record_weight"]);
export type Intent = z.infer<typeof IntentSchema>;

export const ModifyActionSchema = z.enum(["update", "delete", "append"]);
export type ModifyAction = z.infer<typeof ModifyActionSchema>;

export const MealTypeSchema = z.enum(["breakfast", "lunch", "dinner", "snack"]);
export type MealType = z.infer<typeof MealTypeSchema>;

export const PortionLabelSchema = z.enum(["small", "medium", "large", "custom"]);
export type PortionLabel = z.infer<typeof PortionLabelSchema>;

// 进食场景（T32）：外卖/食堂/自制油量与份量系统性不同，scene 层偏差参与融合（LEARNING_SPEC §4）
export const SceneSchema = z.enum(["takeout", "canteen", "home", "unknown"]);
export type Scene = z.infer<typeof SceneSchema>;

// ---------- 份量估算 ----------
export const PortionSchema = z.object({
  label: PortionLabelSchema,
  grams: z.number().positive(),
  unit: z.enum(["g", "ml"]).optional().default("g"),
});

// ---------- 单个食物条目 ----------
const FoodItemBaseSchema = z.object({
  raw: z.string(),
  canonical: z.string(),
  quantity_expr: z.string(),
  // T52：结构化份数，仅供餐食卡展示 `食物名 ×count`，绝不参与算账（铁律 1）。
  // 只在原话有明确可数份量时填（"两个包子"→2,"个"；"一碗面"→1,"碗"），纯重量/容量（"50克瘦肉"）留空。
  count: z.number().positive().optional(),
  count_unit: z.string().optional(),
  portions: z.array(PortionSchema).min(1).max(4),
  chosen_label: PortionLabelSchema,
  food_confidence: z.number().min(0).max(1),
  portion_confidence: z.number().min(0).max(1),
  is_ambiguous: z.boolean(),
  ai_candidates: z.array(z.string()).optional(),
});
export type FoodItem = z.infer<typeof FoodItemBaseSchema>;

// T42 护栏：模型偶发返回 chosen_label 在 portions 中不存在的形态（典型：三档小/中/大 + chosen=custom）。
// 硬拒绝会触发重试链，两个模型都犯错时整条记录兜底成 chat 丢失——比记错更糟，所以就地归一化：
// 1) quantity_expr 有精确数量（"100克"/"200ml"）→ 补一条 custom 档，chosen 指向它（用户明示数量绝不改档）
// 2) 提不出数量 → chosen 回退 medium（小份是最差默认，不用 portions[0]）
export function ensureChosenPortion(item: FoodItem): FoodItem {
  if (item.portions.some((p) => p.label === item.chosen_label)) return item;

  const m = item.quantity_expr.match(/(\d+(?:\.\d+)?)\s*(毫升|克|ml|g)/i);
  if (m) {
    const grams = parseFloat(m[1]);
    const unit = /毫升|ml/i.test(m[2]) ? ("ml" as const) : ("g" as const);
    return {
      ...item,
      chosen_label: "custom",
      portions: [...item.portions, { label: "custom", grams, unit }],
    };
  }

  const fallback = item.portions.find((p) => p.label === "medium") ?? item.portions[0];
  return { ...item, chosen_label: fallback.label };
}

export const FoodItemSchema = FoodItemBaseSchema.transform(ensureChosenPortion);

// ---------- 运动条目 ----------
export const ExerciseItemSchema = z.object({
  type: z.string(),
  duration_min: z.number().positive().optional(),
  reps: z.number().positive().optional(),
  intensity: z.string().optional(),
  calories_burned: z.number().positive().optional(), // T50：用户在 record 消息里自报的消耗（"消耗590卡"），有则直接采信、跳过 MET
});
export type ExerciseItem = z.infer<typeof ExerciseItemSchema>;

// ---------- 修改变更（modify.update 用） ----------
// T53 护栏：模型偶发给用不到的可选字段填显式 null（如改份量时 change.food_desc:null），
// strict optional 会硬拒 → 整条解析抛错触发 pro 重试链、双模型都 null 时丢掉修改。
// 校验前先剥掉所有 null 值键（等价于"没填"），避免因一个多余 null 丢整个动作。
export const ModifyChangeSchema = z.preprocess(
  (v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (val !== null) o[k] = val;
      return o;
    }
    return v;
  },
  z.object({
    portion_label: PortionLabelSchema.optional(),
    grams: z.number().positive().optional(),          // 改份量时 AI 估算的新克数
    food: z.string().optional(),                      // 改食物时的新标准名
    meal_type: MealTypeSchema.optional(),             // 改餐次（"粽子是中午吃的"），数值不动
    calories_burned: z.number().positive().optional(), // 改运动消耗时的新热量值（用户用穿戴设备数据纠正 AI 估算）
    calories: z.number().positive().optional(),        // T40：食物记录改热量，用户亲口给出的数字（用户真值），不由 AI 算
    food_desc: z.string().min(1).optional(),           // T40：食物属性修正描述（如"无油"），影响营养口径，触发重估
  }),
);
export type ModifyChange = z.infer<typeof ModifyChangeSchema>;

// ---------- 单意图变体（record / modify 同时是 multi 的 op 单元，T45） ----------
export const RecordVariantSchema = z.object({
  intent: z.literal("record"),
  raw: z.string().optional(),                   // multi 时该动作对应的原文子句（餐次提取/兜底估算按子句而非全文）
  meal_type: MealTypeSchema.optional(),
  scene: SceneSchema.optional(),                // 原话提不出场景时 AI 填 unknown 或省略
  items: z.array(FoodItemSchema).optional(),
  exercise: z.array(ExerciseItemSchema).optional(),
}).refine(
  (v) => (v.items && v.items.length > 0) || (v.exercise && v.exercise.length > 0),
  { message: "record 意图至少需要 items 或 exercise 之一" },
);

export const ModifyVariantSchema = z.object({
  intent: z.literal("modify"),
  raw: z.string().optional(),                   // multi 时该动作对应的原文子句
  action: ModifyActionSchema,
  // 引用记忆包 recent_records.ref（如 r1/e1）。批量改餐次（"以上都是早餐"）时为 ref 数组
  target: z.union([z.string(), z.array(z.string()).min(1)]),
  change: ModifyChangeSchema.optional(),         // action=update 时
  items: z.array(FoodItemSchema).optional(),     // action=append 时
  modify_confidence: z.number().min(0).max(1).optional(),
});

// multi 的动作单元：只允许 record / modify（query/chat/discuss 不进 ops，见 parser 提示词）
export const MultiOpSchema = z.discriminatedUnion("intent", [RecordVariantSchema, ModifyVariantSchema]);
export type MultiOp = z.infer<typeof MultiOpSchema>;

// ---------- 完整解析结果 ----------
export const ParseResultSchema = z.discriminatedUnion("intent", [
  RecordVariantSchema,
  z.object({
    intent: z.literal("query"),
  }),
  z.object({
    intent: z.literal("chat"),
  }),
  ModifyVariantSchema,
  z.object({
    intent: z.literal("discuss"),
    target: z.string(),                          // 引用记忆包 recent_records.ref（如 r1/e1）
  }),
  z.object({
    intent: z.literal("resolve_pending"),
    // 用户打字回答【待确认】卡片（T38）：份量档位/食物名(string) 或自定义克数({grams})
    choice: z.union([z.string().min(1), z.object({ grams: z.number().positive() })]),
  }),
  z.object({
    intent: z.literal("record_weight"),
    // 用户口头上报当日实测体重（"今天体重77.75公斤"）：只 append weight_log 历史点，
    // 绝不动 User.weight_kg（初始体重）与 target_weight_kg（见 LEARNING_SPEC §8）
    weight_kg: z.number().min(20).max(500),
  }),
  z.object({
    intent: z.literal("multi"),                  // T45：一条消息多个独立动作，按序执行
    ops: z.array(MultiOpSchema).min(2).max(4),
  }),
]);
export type ParseResult = z.infer<typeof ParseResultSchema>;

// ---------- Tool call schema (DeepSeek strict mode) ----------
export const PARSE_TOOL_NAME = "parse_user_input";

// 共享属性定义（T45）：顶层单意图与 multi.ops 的动作单元引用同一份，改一处两边生效
const actionProp = {
  type: "string",
  enum: ["update", "delete", "append"],
  description: "仅 intent=modify 必填。update=改份量/改食物（含量词减量，见下）; delete=删整条记录; append=在某餐追加新食物。" +
    "量词减量不是删除（T49）：用户只想去掉部分数量（'删掉一个'/'少一个'/'其实只吃了一个'），且该记录份量明显对应多份（如'2个李子'记了60g）→ 判 update，" +
    "change.grams 填按比例减去后的新克数（60g 删一个→30g），不要判 delete；只有清空整条（'把X删了'，无量词限定）才判 delete",
};
const targetProp = {
  description: "intent=modify 或 discuss 时必填。引用【今日已记录】里的 ref（如 r1、e1），指明操作/讨论的是哪条记录。仅 modify+update 改餐次且用户明显指多条时（'以上都是早餐'、'刚才发的都是晚饭'）填 ref 数组，其余场景一律填单个字符串",
  anyOf: [
    { type: "string" },
    { type: "array", items: { type: "string" } },
  ],
};
const changeProp = {
  type: "object",
  additionalProperties: false,
  description: "仅 action=update 填。改份量填 portion_label+grams（grams 为该食物该档的估算净重）；改食物填 food（新标准名）；改餐次填 meal_type（如'粽子是中午吃的'→lunch，克数食物都不动、不要顺手填 grams）；改运动消耗填 calories_burned（用户用穿戴设备数据纠正）；用户直接指定食物记录最终热量填 calories（用户真值，如'记录成180kcal'）；营养口径的属性修正填 food_desc（如'无油'）",
  properties: {
    portion_label: { type: "string", enum: ["small", "medium", "large", "custom"] },
    grams: { type: "number" },
    food: { type: "string" },
    meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
    calories_burned: { type: "number" },
    calories: { type: "number", description: "食物记录的最终热量(kcal)，用户亲口给出的数值（用户真值，不是AI估算），如'记录成180kcal'、'按150卡记'。填这个时通常不要同时填 grams/portion_label（除非用户也确实说了新克数）" },
    food_desc: { type: "string", description: "食物属性修正描述，影响营养口径的（如'无油'、'无糖'、'去皮'、'脱脂'）。只填修正词本身，不要重复食物名；纯口感/无关描述（'有点咸'、'挺好吃'）不要填这个，应整体判 chat" },
  },
};
const modifyConfidenceProp = {
  type: "number",
  description: "仅 intent=modify 填。对「改哪条+怎么改」整体把握度 0~1",
};
const mealTypeProp = {
  type: "string",
  enum: ["breakfast", "lunch", "dinner", "snack"],
  description: "仅 intent=record 且能判断时填写",
};
const sceneProp = {
  type: "string",
  enum: ["takeout", "canteen", "home", "unknown"],
  description: "仅 intent=record 填。进食场景，只从用户原话提取：点外卖/叫的/点了个→takeout；食堂/单位餐厅→canteen；自己做/煮/在家做的→home；原话没有场景线索→unknown，不要猜",
};
const itemsProp = {
  type: "array",
  description: "食物条目列表，intent=record 时必填",
  items: {
    type: "object",
    required: [
      "raw", "canonical", "quantity_expr", "portions",
      "chosen_label", "food_confidence", "portion_confidence", "is_ambiguous",
    ],
    additionalProperties: false,
    properties: {
      raw: { type: "string", description: "用户原始表达" },
      canonical: { type: "string", description: "归一后标准食物名（中文，供数据库匹配）" },
      quantity_expr: { type: "string", description: "原始份量表达，如'一碗'、'半个'" },
      count: { type: "number", description: "可数份数，仅当原话有明确可数份量时填（'两个包子'→2、'一碗面'→1、'三片面包'→3）；纯重量/容量表达（'50克瘦肉'、'200ml牛奶'）不填。仅用于展示，不影响热量" },
      count_unit: { type: "string", description: "与 count 配套的量词（'个'/'碗'/'片'/'根'），填了 count 才填；count 不填则不填" },
      portions: {
        type: "array",
        description: "小/中/大三档份量估算，含单位和克数(ml)",
        items: {
          type: "object",
          required: ["label", "grams"],
          additionalProperties: false,
          properties: {
            label: { type: "string", enum: ["small", "medium", "large", "custom"] },
            grams: { type: "number" },
            unit: { type: "string", enum: ["g", "ml"], description: "固体食物用g，液体/饮品用ml" },
          },
        },
      },
      chosen_label: {
        type: "string",
        enum: ["small", "medium", "large", "custom"],
        description: "根据 quantity_expr 选定的档位",
      },
      food_confidence: { type: "number", description: "食物识别置信度 0~1" },
      portion_confidence: { type: "number", description: "份量估算置信度 0~1" },
      is_ambiguous: { type: "boolean", description: "食物名称是否有歧义（如'煎饼'可指煎饼果子/鸡蛋煎饼等多种，'粥'可指多种粥），true时需用户澄清" },
      ai_candidates: {
        type: "array",
        description: "is_ambiguous=true时，列出该泛称最可能指的具体食物名（标准中文名，最多3个，按可能性降序），供用户选择。例如'煎饼'→['煎饼果子','鸡蛋煎饼','酱香饼']",
        items: { type: "string" },
      },
    },
  },
};
const exerciseProp = {
  type: "array",
  description: "运动条目，有运动记录时填写。持续型运动（跑步/球类）填 duration_min，次数型运动（俯卧撑/引体向上/深蹲）填 reps，两者可同时有",
  items: {
    type: "object",
    required: ["type"],
    additionalProperties: false,
    properties: {
      type: { type: "string" },
      duration_min: { type: "number" },
      reps: { type: "number", description: "次数型运动的总次数（如俯卧撑、引体向上），与 duration_min 二选一或同时有" },
      intensity: { type: "string" },
      calories_burned: { type: "number", description: "用户在记录时明确自报的消耗热量（\"消耗590卡\"、\"烧了500大卡\"），有则填、后端直接采信跳过 MET 估算；只描述时长/次数、没给卡数时不要填" },
    },
  },
};

// multi 的动作单元（T45）：与顶层同构的 record/modify 子集，另带 raw 原文子句
const opSchema = {
  type: "object",
  required: ["intent"],
  additionalProperties: false,
  properties: {
    intent: {
      type: "string",
      enum: ["record", "modify"],
      description: "该动作的类型，只允许 record 或 modify",
    },
    raw: {
      type: "string",
      description: "该动作对应的原文子句，照抄用户原话，不要改写不要遗漏修饰词",
    },
    action: actionProp,
    target: targetProp,
    change: changeProp,
    modify_confidence: modifyConfidenceProp,
    meal_type: mealTypeProp,
    scene: sceneProp,
    items: itemsProp,
    exercise: exerciseProp,
  },
};

export const parseToolSchema = {
  type: "function" as const,
  function: {
    name: PARSE_TOOL_NAME,
    strict: true,
    description:
      "解析用户的饮食/运动/问询文本，输出结构化意图与食物份量信息。",
    parameters: {
      type: "object",
      required: ["intent"],
      additionalProperties: false,
      properties: {
        intent: {
          type: "string",
          enum: ["record", "query", "chat", "modify", "discuss", "resolve_pending", "record_weight", "multi"],
          description: "record=记录饮食/运动; query=查询自己的饮食/运动数据(任意日期/区间/某食物次数/总结回顾); modify=改/删/追加已记录的食物; discuss=针对某条已有记录提问/质疑(不动数据); resolve_pending=打字回答上下文里的【待确认】卡片; record_weight=用户上报自己当日实测体重(如'今天体重77.75公斤'、'现在体重到了68了')，只记体重历史点，不改初始/目标体重; multi=一条消息同时包含多个独立动作(如 删某条+记录新食物)，动作放 ops 按序执行; chat=其他闲聊/营养咨询",
        },
        action: actionProp,
        target: targetProp,
        change: changeProp,
        modify_confidence: modifyConfidenceProp,
        choice: {
          description: "仅 intent=resolve_pending 必填。回答的是份量档位/食物名就填字符串（'small'/'medium'/'large'/具体食物名）；回答的是精确克数就填 {grams:数字}",
          anyOf: [
            { type: "string" },
            {
              type: "object",
              additionalProperties: false,
              required: ["grams"],
              properties: { grams: { type: "number" } },
            },
          ],
        },
        weight_kg: {
          type: "number",
          description: "仅 intent=record_weight 必填。用户上报的实测体重，单位公斤（'77.75公斤'/'68kg'→77.75/68；'150斤'→75）。合理范围 20~500，超出别填这个意图",
        },
        meal_type: mealTypeProp,
        scene: sceneProp,
        items: itemsProp,
        exercise: exerciseProp,
        ops: {
          type: "array",
          description: "仅 intent=multi 必填。2~4 个动作，按用户叙述顺序排列；每个动作的结构与对应单意图完全一致（record 填 items/meal_type/scene，modify 填 action/target/change），另加 raw 填该动作对应的原文子句",
          items: opSchema,
        },
      },
    },
  },
};
