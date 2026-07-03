# T32 — 场景偏差（P4：外卖/食堂/自制的系统性差异）

**状态**：✅完成

**目标**：同名菜在外卖/食堂/自制场景油量与份量差 30-50%。让 parser 从原话提取场景，场景层偏差参与融合。
**依赖**：T31　**关注文档**：LEARNING_SPEC §4 §7、AI_PARSING_SPEC §3

## 做什么
- parser record 协议加 `scene: "takeout"|"canteen"|"home"|"unknown"`：DeepSeek strict tool schema + `ai/schema.ts` zod + parse prompt 提取规则与示例（"点了个外卖麻辣香锅"→takeout；"食堂打的饭"→canteen；"自己煮的"→home；提不出→unknown）。**同步更新 AI_PARSING_SPEC §3 协议示例。**
- Prisma 迁移：`food_record` 加 `scene text?`；入库时落值。
- learning_event 的 scene 从此有值；`updateBias`/`applyBias` 接入 scene 层（unknown 不建 bias 行、不参与融合）。

## 验收
- "中午点了外卖黄焖鸡" → food_record.scene=takeout，learning_event 同步；无场景词 → unknown。
- 构造场景纠正数据后，同食物 takeout 与 home 两次记录的 applyBias 结果不同；unknown 场景不受影响。
- parse 回归：无场景词的常规输入解析结果与 T31 一致（zod 不因新字段变严）。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/LEARNING_SPEC.md §4 §7、docs/AI_PARSING_SPEC.md §3。只做任务 T32：parser 加 scene 字段（schema+zod+prompt，更新 AI_PARSING_SPEC）、food_record 加 scene 列、scene 层接入 updateBias/applyBias（unknown 不参与）。验收含无场景词回归。
