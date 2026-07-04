# T48 — MealCard 前端组件：折叠汇总 + 展开明细 + 项级撤销（P3 同餐食物分组）

**状态**：✅完成（2026-07-04）

**目标**：渲染 meal_card。**默认展开**：标题行汇总 + 食材明细逐项 + 宏量素总计行；点标题可收起为一行汇总；`last_change` 对应项显示撤销按钮（复用现有 undo 链路）；空餐显示"已清空"灰态。

**依赖**：T47（后端全路径 + store upsert 已就位）
**关注文档**：DESIGN_SPEC（MealCard 规格，本任务补写）、TESTING.md（组件测试规范）、frontend/AGENTS.md（Expo v56 文档要求）

## 设计要点（形态 2026-07-04 与用户确认）

- **展开态（默认）**：
  ```
  ✓ 早餐 · 4 项                      385 kcal
    全麦面包2片                          174
    水煮鸡蛋1个                           72
    纯牛奶250ml                          113
    小番茄6颗                             26
    ● 蛋白 24.6g  ● 脂肪 12.3g  ● 碳水 42.1g
  ```
  一餐一卡后展开态撑死 6~8 行，比原先四五张卡还省空间，明细直接可见（口述修改前不用点开确认）。视觉沿用 record-card.tsx 的骨架（GlassCard、badge 图标、右侧大号热量、宏量素圆点行），单项时也用此形态（决策：全项目只有一种饮食卡）。餐次文案复用 MEAL_LABEL 映射。
  - 每项主显示 `raw_input`（原话，自然单位），为空/失真时兜底 `food_name + weight_g`；右侧每项 kcal；`is_estimated` 沿用现有"估"角标口径。
  - `payload.last_change.record_id` 匹配的项右侧显示「撤销」（调 `useChatStore.undo`，prev_state 取自 last_change；无 prev_state = 删除语义）。已撤销后本项进灰态（复用 undoneCards 机制）。
  - 引导提示不放卡上（首次提示由后端在 record 回复文本里带，见 T46）。
- **收起态**：点标题行切换，收成 `✓ 早餐 · 4 项  385 kcal` + 宏量素行两行。
- **空餐态**：`items.length === 0` → 卡片整体灰化 + "已清空"文案（对齐现有 cardUndone 样式）。
- **状态注意**：展开/收起是纯本地 UI 态（组件 state），卡片 bump 重排后保持组件 key = message.id 避免展开态丢失；payload 每次都是后端实时组装的完整数据，**组件不做任何求和**（铁律 1：显示后端算好的 totals，含每项 kcal）。
- **旧卡兼容**：record_card / exercise_card 渲染分支原样保留（历史消息回放）。
- 类型：`types/chat.ts` 加 `'meal_card'` kind 与 `MealCardPayload`（items / totals / item_count / meal_key / last_change）。

## 改动清单

- `frontend/src/components/chat/meal-card.tsx`：新建组件。
- `frontend/src/components/chat/message-item.tsx`：case 'meal_card'。
- `frontend/src/types/chat.ts`：kind 联合 + MealCardPayload。
- `frontend/src/components/chat/__tests__/meal-card.test.tsx`：按 TESTING.md 规范。
- `docs/DESIGN_SPEC.md`：MealCard 行为规格（折叠/展开/撤销/空态/跟随行为说明）。

## 验收

1. 组件测试：默认展开渲染明细（raw_input 主显示、缺失时兜底 food_name+克数）与总热量；点标题收起为两行汇总；last_change 项显示撤销按钮、点击调用 undo、撤销后灰态；items:[] 显示已清空；无 last_change 时不出现任何按钮。
2. 真机/模拟器走查：记三样 → 一张卡；"还有一个鸡蛋" → 同卡长出第四项并浮到底部，展开态不丢；"米饭改成两碗" → 卡片浮起数据更新；撤销还原。
3. 历史消息回放：旧 record_card 与新 meal_card 混排显示正常。
4. `npm test`（frontend）全绿。
