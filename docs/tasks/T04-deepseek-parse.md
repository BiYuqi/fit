# T04 — DeepSeek 客户端 + 解析协议 + 意图路由

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：把一句话解析成结构化 JSON（意图 + 食物 + 份量 + 置信度）。
**依赖**：T01　**关注文档**：AI_PARSING_SPEC §1–4

## 做什么
- `backend/src/ai/client.ts`：openai SDK 接 `https://api.deepseek.com`，模型 `deepseek-v4-flash`；strict tool-call 结构化输出 + zod 校验 + 429/5xx 重试 + 空响应处理。
- 在 backend 内（必要时也放一份 zod 到便于前端引用处）定义解析 tool schema 与 zod。
- `backend/src/services/parser.ts`：输入文本 → 返回 `{intent, meal_type?, items[]}`；意图判 record/query/chat。

## 验收
- "中午吃了碗牛肉面"→record 且 items 含 canonical/portions/置信度，过 zod。
- "我今天还能吃多少"→query；"减脂能吃香蕉吗"→chat。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/AI_PARSING_SPEC.md。只做任务 T04：实现 DeepSeek 客户端(deepseek-v4-flash, strict tool calls, zod 校验, 重试)与 parser 服务(意图路由 + record 解析协议)。用三条样本验证意图与解析结构。不要做匹配或计算。
