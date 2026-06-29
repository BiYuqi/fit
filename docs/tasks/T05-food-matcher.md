# T05 — 食物匹配管线

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：把 canonical 名匹配到 food_standard，匹配不到则 AI 估算落库。
**依赖**：T03 T04　**关注文档**：AI_PARSING_SPEC §5，FOOD_DB_SPEC §3

## 做什么
- `backend/src/services/matcher.ts`：canonical → 精确 name → aliases → pg_trgm 模糊(similarity≥0.3，取最高若干) → 都不中则调 DeepSeek 估三大营养素并 insert（is_estimated=true，必要时 is_composite=true）→ 返回该 food_standard 行。

## 验收
- "牛肉面" 命中库中行。
- 生僻复合菜（如"老北京铜锅涮肉"）走估算并新落一条，第二次输入变命中。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/AI_PARSING_SPEC.md。只做任务 T05：实现食物匹配管线(精确→别名→pg_trgm→AI估算落库)。用一个命中例和一个兜底例验证，兜底后二次查询应命中。
