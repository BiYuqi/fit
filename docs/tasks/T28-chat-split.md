# T28 — chat.ts 拆分重构（学习系统前置，纯搬家零行为变化）

**状态**：⬜待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：`routes/chat.ts` 已 1386 行、四层职责混装（工具/AI调用/业务管线/路由）。拆成小文件，让 T29 的学习 hook 落在两三百行的文件里。**纯内部重构：不改任何行为、不动 trace 语义、不碰 API_SPEC。**
**依赖**：T27　**关注文档**：LEARNING_SPEC §2（hook 落点）

## 做什么（按风险从低到高逐步搬，每步跑测试）
1. `lib/dates.ts`：todayStr / toDateOnly / guessMealType / extractMealTypeFromText。
2. `services/exercise.ts`：MET 表 + calcExerciseCalories + resolveDuration。
3. `ai/answers.ts`：answerQuery / answerChat / answerDiscuss（提示词集中地，T31 改 discuss 就在这）。
4. `services/food-item.ts`：processFoodItem + inferMatchPath + ItemCtx/ItemResult（学习 hook 落点③）。
5. `routes/chat-history.ts`：GET messages / dates / range；**抽出共用 `enrichResolved()`**（现两端点 40 行逐行复制，:1265-1296 vs :1351-1382）。
6. `routes/pending.ts`：POST /pending/:id/resolve（hook 落点①）；`routes/records.ts`：POST /records/:id/undo。
7. `services/intents/`：message handler 按 intent 提函数 record.ts（含 record/append 共用的 items 循环，现写了两遍）/ modify.ts（hook 落点②）/ query.ts（含 fetchDayData + extractQueryDate）。chat.ts 最终只剩薄壳 + 路由注册。

**不做**：processFoodItem 内 trace 样板压缩（行为相邻，另行评估）；任何顺手优化。

## 验收
- `npm test`（chat.test.ts）通过；TEST_PLAN 的 curl 流程抽测：record 自动入库 / 份量卡 resolve / 候选卡两步 resolve / modify update / undo / 历史消息 enrichment——响应与拆前一致。
- chat.ts ≤ ~200 行；enrichment 逻辑只存在一份。
- `git diff` 审查确认纯移动（无逻辑改动）。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/LEARNING_SPEC.md §2。只做任务 T28：把 backend/src/routes/chat.ts 按上述 7 步拆分，纯搬家零行为变化，每步跑 chat.test.ts。重点：抽出两处复制的 enrichResolved、record/append 共用 items 循环。不做任何行为优化。
