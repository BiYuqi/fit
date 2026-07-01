import { z } from "zod";

// ---------- 枚举 ----------
export const IntentSchema = z.enum(["record", "query", "chat", "modify", "discuss"]);
export type Intent = z.infer<typeof IntentSchema>;

export const ModifyActionSchema = z.enum(["update", "delete", "append"]);
export type ModifyAction = z.infer<typeof ModifyActionSchema>;

export const MealTypeSchema = z.enum(["breakfast", "lunch", "dinner", "snack"]);
export type MealType = z.infer<typeof MealTypeSchema>;

export const PortionLabelSchema = z.enum(["small", "medium", "large", "custom"]);
export type PortionLabel = z.infer<typeof PortionLabelSchema>;

// ---------- 份量估算 ----------
export const PortionSchema = z.object({
  label: PortionLabelSchema,
  grams: z.number().positive(),
});

// ---------- 单个食物条目 ----------
export const FoodItemSchema = z.object({
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
export type FoodItem = z.infer<typeof FoodItemSchema>;

// ---------- 运动条目 ----------
export const ExerciseItemSchema = z.object({
  type: z.string(),
  duration_min: z.number().positive().optional(),
  intensity: z.string().optional(),
});
export type ExerciseItem = z.infer<typeof ExerciseItemSchema>;

// ---------- 修改变更（modify.update 用） ----------
export const ModifyChangeSchema = z.object({
  portion_label: PortionLabelSchema.optional(),
  grams: z.number().positive().optional(), // 改份量时 AI 估算的新克数
  food: z.string().optional(),             // 改食物时的新标准名
});
export type ModifyChange = z.infer<typeof ModifyChangeSchema>;

// ---------- 完整解析结果 ----------
export const ParseResultSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("record"),
    meal_type: MealTypeSchema.optional(),
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
          enum: ["record", "query", "chat", "modify", "discuss"],
          description: "record=记录饮食/运动; query=查询今日汇总数据; modify=改/删/追加已记录的食物; discuss=针对某条已有记录提问/质疑(不动数据); chat=其他闲聊/营养咨询",
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
          description: "仅 action=update 填。改份量填 portion_label+grams（grams 为该食物该档的估算净重）；改食物填 food（新标准名）",
          properties: {
            portion_label: { type: "string", enum: ["small", "medium", "large", "custom"] },
            grams: { type: "number" },
            food: { type: "string" },
          },
        },
        modify_confidence: {
          type: "number",
          description: "仅 intent=modify 填。对「改哪条+怎么改」整体把握度 0~1",
        },
        meal_type: {
          type: "string",
          enum: ["breakfast", "lunch", "dinner", "snack"],
          description: "仅 intent=record 且能判断时填写",
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
                description: "小/中/大三档克数估算",
                items: {
                  type: "object",
                  required: ["label", "grams"],
                  additionalProperties: false,
                  properties: {
                    label: { type: "string", enum: ["small", "medium", "large", "custom"] },
                    grams: { type: "number" },
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
          description: "运动条目，有运动记录时填写",
          items: {
            type: "object",
            required: ["type"],
            additionalProperties: false,
            properties: {
              type: { type: "string" },
              duration_min: { type: "number" },
              intensity: { type: "string" },
            },
          },
        },
      },
    },
  },
};
