import { z } from "zod";

// ---------- 枚举 ----------
export const IntentSchema = z.enum(["record", "query", "chat"]);
export type Intent = z.infer<typeof IntentSchema>;

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

// ---------- 完整解析结果 ----------
export const ParseResultSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("record"),
    meal_type: MealTypeSchema.optional(),
    items: z.array(FoodItemSchema).min(1),
    exercise: z.array(ExerciseItemSchema).optional(),
  }),
  z.object({
    intent: z.literal("query"),
  }),
  z.object({
    intent: z.literal("chat"),
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
          enum: ["record", "query", "chat"],
          description: "record=记录饮食/运动; query=查询数据; chat=闲聊/营养咨询",
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
