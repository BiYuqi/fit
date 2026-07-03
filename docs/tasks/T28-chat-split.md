# T28 — chat.ts 拆分重构（学习系统前置，纯搬家零行为变化）

**状态**：✅完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：`routes/chat.ts` 已 1386 行、四层职责混装（工具/AI调用/业务管线/路由）。拆成小文件，让 T29 的学习 hook 落在两三百行的文件里。**纯内部重构：不改任何行为、不动 trace 语义、不碰 API_SPEC。**
**依赖**：T27　**关注文档**：LEARNING_SPEC §2（hook 落点）

## 做什么（按风险从低到高逐步搬，每步跑测试）
1. `lib/dates.ts`：todayStr / toDateOnly / guessMealType / extractMealTypeFromText。
2. `services/intents/exercise.ts`：MET 表 + calcExerciseCalories + resolveDuration。
3. `ai/answers.ts`：answerQuery / answerChat / answerDiscuss（提示词集中地，T31 改 discuss 就在这）。
4. `services/intents/food-item.ts`：processFoodItem + inferMatchPath + ItemCtx/ItemResult + `processItems()`（学习 hook 落点③；`processItems()` 是 record/modify.append 共用的 items 循环，见步骤7）。
5. `routes/chat-history.ts`：GET messages / dates / range；**抽出共用 `enrichResolved()`**（原两端点 40 行逐行复制）。
6. `routes/pending.ts`：POST /pending/:id/resolve（hook 落点①）；`routes/records.ts`：POST /records/:id/undo。
7. `services/intents/`：message handler 按 intent 提函数 record.ts / modify.ts（hook 落点②）/ query.ts（含 fetchDayData + extractQueryDate）/ types.ts（共享 IntentCtx）。chat.ts 最终只剩薄壳 + 路由注册。

**不做**：processFoodItem 内 trace 样板压缩（行为相邻，另行评估）；任何顺手优化。

### 目录边界：`services/` 根目录 vs `services/intents/`

事后复查一遍，把 `food-item.ts` / `exercise.ts` 从 `services/` 根目录挪进了 `services/intents/`（原第4/2步初版落在根目录，现已就位）。分界线不是"chat.ts 拆出来的都归一堆"，而是按**真实调用方**分：

- 留在 `services/` 根目录的（matcher / calc / summary / trace / token / memory / parser）：全部被 **`pending.ts`、`records.ts`、`user.ts` 等与 chat.ts 平级的独立路由**消费，是跨路由的引擎/基础设施，不是 chat 专属。T28 把 resolve/undo 拆成独立路由后，这些文件被多个平级端点依赖，塞进任何一个"chat"目录都会误导依赖方向。
- 挪进 `services/intents/` 的（food-item.ts、exercise.ts）：验证后调用方只有 `intents/modify.ts` 和 `intents/record.ts`，别无他处，且 LEARNING_SPEC 后续任务（T30 食物直连、T31 份量偏差）也是在 `processFoodItem` 内部加 hook，不会新增外部调用方。归入 `intents/` 是准确的。

**顺带修的一个 bug**：`exercise.test.ts` 挪进 `services/intents/` 后 `npm test` 只跑出 41/45 个测试——`package.json` 的 `"test": "node --require tsx/cjs --test src/**/*.test.ts"` 这个 glob 是被 `sh`（npm 脚本走 POSIX sh，非 zsh）展开的，POSIX sh 不支持 `**` 递归匹配，只能匹配到 `src/` 下一层，测试文件挪深一层就悄悄漏跑。改成把 glob 用引号包起来交给 Node 自己的 glob 引擎展开（`"--test \"src/**/*.test.ts\""`，Node 20.13+/22+ 支持），恢复递归匹配，也顺带修好了这个此前一直存在但没暴露的隐患——以后测试文件不管嵌多深都能被发现。

## 验收
- `npm test` 45/45 通过（含新位置的 `services/intents/exercise.test.ts`）；TEST_PLAN 的 curl 流程全跑：register→onboarding→record 自动入库→query→modify update→discuss→undo→份量卡 resolve→候选卡/delete_confirm 两步 resolve→daily/today 一致性——响应与拆前一致，且在真实开发服务器（`tsx watch`）上验证过热重载不崩。
- chat.ts 173 行；enrichment 逻辑只存在一份。
- `git diff` 审查确认纯移动（无逻辑改动，除 discuss 分支去掉一处多余类型断言、`test` 脚本 glob 的一处 bug 修复）。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/LEARNING_SPEC.md §2。只做任务 T28：把 backend/src/routes/chat.ts 按上述 7 步拆分，纯搬家零行为变化，每步跑 chat.test.ts。重点：抽出两处复制的 enrichResolved、record/append 共用 items 循环。不做任何行为优化。
