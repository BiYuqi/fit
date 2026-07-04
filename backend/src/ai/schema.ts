import { z } from "zod";

// ---------- 枚举 ----------
export const IntentSchema = z.enum(["record", "query", "chat", "modify", "discuss", "resolve_pending"]);
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
});
export type ExerciseItem = z.infer<typeof ExerciseItemSchema>;

// ---------- 修改变更（modify.update 用） ----------
export const ModifyChangeSchema = z.object({
  portion_label: PortionLabelSchema.optional(),
  grams: z.number().positive().optional(),          // 改份量时 AI 估算的新克数
  food: z.string().optional(),                      // 改食物时的新标准名
  meal_type: MealTypeSchema.optional(),             // 改餐次（"粽子是中午吃的"），数值不动
  calories_burned: z.number().positive().optional(), // 改运动消耗时的新热量值（用户用穿戴设备数据纠正 AI 估算）
  calories: z.number().positive().optional(),        // T40：食物记录改热量，用户亲口给出的数字（用户真值），不由 AI 算
  food_desc: z.string().min(1).optional(),           // T40：食物属性修正描述（如"无油"），影响营养口径，触发重估
});
export type ModifyChange = z.infer<typeof ModifyChangeSchema>;

// ---------- 完整解析结果 ----------
export const ParseResultSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("record"),
    meal_type: MealTypeSchema.optional(),
    scene: SceneSchema.optional(),              // 原话提不出场景时 AI 填 unknown 或省略
    items: z.array(FoodItemSchema).optional(),
    exercise: z.array(ExerciseItemSchema).optional(),
  }).refine(
    (v) => (v.items && v.items.length > 0) || (v.exercise && v.exercise.length > 0),
    { message: "record 意图至少需要 items 或 exercise 之一" },
  ),
  z.object({
    intent: z.literal("query"),
  }),
  z.object({
    intent: z.literal("chat"),
  }),
  z.object({
    intent: z.literal("modify"),
    action: ModifyActionSchema,
    target: z.string(),                          // 引用记忆包 recent_records.ref（如 r1/e1）
    change: ModifyChangeSchema.optional(),       // action=update 时
    items: z.array(FoodItemSchema).optional(),   // action=append 时
    modify_confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    intent: z.literal("discuss"),
    target: z.string(),                          // 引用记忆包 recent_records.ref（如 r1/e1）
  }),
  z.object({
    intent: z.literal("resolve_pending"),
    // 用户打字回答【待确认】卡片（T38）：份量档位/食物名(string) 或自定义克数({grams})
    choice: z.union([z.string().min(1), z.object({ grams: z.number().positive() })]),
  }),
]);
export type ParseResult = z.infer<typeof ParseResultSchema>;

// ---------- Tool call schema (DeepSeek strict mode) ----------
export const PARSE_TOOL_NAME = "parse_user_input";

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
          enum: ["record", "query", "chat", "modify", "discuss", "resolve_pending"],
          description: "record=记录饮食/运动; query=查询自己的饮食/运动数据(任意日期/区间/某食物次数/总结回顾); modify=改/删/追加已记录的食物; discuss=针对某条已有记录提问/质疑(不动数据); resolve_pending=打字回答上下文里的【待确认】卡片; chat=其他闲聊/营养咨询",
        },
        action: {
          type: "string",
          enum: ["update", "delete", "append"],
          description: "仅 intent=modify 必填。update=改份量/改食物; delete=删一条; append=在某餐追加新食物",
        },
        target: {
          type: "string",
          description: "intent=modify 或 discuss 时必填。引用【今日已记录】里的 ref（如 r1、e1），指明操作/讨论的是哪条记录",
        },
        change: {
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
        },
        modify_confidence: {
          type: "number",
          description: "仅 intent=modify 填。对「改哪条+怎么改」整体把握度 0~1",
        },
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
        meal_type: {
          type: "string",
          enum: ["breakfast", "lunch", "dinner", "snack"],
          description: "仅 intent=record 且能判断时填写",
        },
        scene: {
          type: "string",
          enum: ["takeout", "canteen", "home", "unknown"],
          description: "仅 intent=record 填。进食场景，只从用户原话提取：点外卖/叫的/点了个→takeout；食堂/单位餐厅→canteen；自己做/煮/在家做的→home；原话没有场景线索→unknown，不要猜",
        },
        items: {
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
        },
        exercise: {
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
            },
          },
        },
      },
    },
  },
};
