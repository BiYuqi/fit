# T53 — 批量修改正确性 + 项级独立撤销（餐食卡 G3）

**状态**：✅完成（2026-07-05）

**验收记录**：后端单测 135/135（新增 last_changes set/clear 合并、批量多条独立撤销态、clear 不串扰、enrich 剪陈旧 + 旧 payload 兼容）+ **变异测试证非空跑**（把合并逻辑改回单槽 → T53 核心测试立刻变红，复原即绿）；前端 59/59（meal-card 项级独立撤销/批量多条各显撤销/撤销串扰/legacy 兼容，exercise-card 改 record_id 键）；前后端 tsc 零错误（真实 exit 0）。确定性集成脚本实测三缺陷：护栏拦住 target 数组+grams 不动数据、multi 三改 DB 全对 + 一张卡三条独立撤销态、撤销瘦肉只还原瘦肉不动玉米面饼且卡上只清该条。

**泛化验证（覆盖广度，非只测截图那句）**：新增 `batch-modify-varied`（换一批食物米饭/蛋/西兰花/牛奶 + 动词五花八门改成/改为/换成/调到/弄成/变成 + 2/3/4 样 + 克/毫升/纯数字混）。首轮跑出**真实抖动点**：省略"克"的两样式（"米饭改成250，牛奶改成350"）模型判 multi 只约 60% 成功、判错时被护栏拦住不腐蚀数据（改回原值+提示）。**据此加强 parser multi 提示词**（判据= "几样各改各的数"，与说法/单位/是否带"克"无关；补纯数字/多动词/4 样示例）后，`batch-modify-varied` **连跑 5 次全绿**、原 `batch-modify` 与 `multi-action`（删+记）各 2 次无回归。附带修掉一个 prompt 模板字符串反引号导致的 tsc 语法错（会崩服务）。eval 属概率性验证，非 100% 保证——线上仍需 AiTrace 跟踪。

已知 eval 抖动（非本改动）：meal-batch/quantifier-delete 红为记录在案的基线抖动，失败轮次逐轮漂移。测试脆点已修（食物名断言用能匹配 canonical 的子串，如"蛋"配"水煮蛋"）。

**大样本鲁棒性（17 种真实说法 × 6 次 = 102 样本，直打真实 parser 逐条核对"食物↔克数/意图"）**：加强提示词后 **101/102 = 99%**。覆盖：带克/纯数字/毫升、动词五花八门（改成/换成/调到/弄成/加到/减到/算/分别改成…）、**省略动词**（"玉米180瘦肉50"）、**倒序**（"瘦肉50克玉米180克"）、**空格分隔**（"玉米150 米饭200 牛奶300"）、**近似语气**（"大概180吧/50左右"）、2/3/4 样、单条不回归、批量改餐次仍走数组。唯一 1 处 5/6 是"加到180、减到50"增减语气偶漏一 op（护栏兜底不腐蚀）。**此测试挖出并修掉一个 clean eval 漏掉的真 schema bug**：模型改份量时偶发 `change.food_desc:null`，strict optional 硬拒 → 整条解析抛错丢动作；`ModifyChangeSchema` 加 preprocess 剥 null 值键，配 2 个单测（单/multi op 内 null 剥离），后端测 137/137。

**顾此失彼排查（确认只动本场景，未伤相邻流程）**：探针发现加强提示词把"记录新食物"误拉进 multi（"中午吃了玉米180克和瘦肉50克" record→multi 25%）→ 收紧 multi 段：**仅对【今日已记录】里的食物改数值才 multi**，"吃了/喝了…"进食动词报的新食物是 record 多 items，不是 multi。收紧后：记录多 food **record 4/4**（over-trigger 消除）；单条改份量/删除/改热量/属性修正各 **modify 4/4** 不变；带动词/带克的清晰改份量仍 ~99%；代价是极简裸数字二义式（"玉米180，瘦肉50" 无动词无克）偏向 record/单条（本就 record↔modify 天然二义，判错时护栏兜底不腐蚀）——判定"保住相邻 record 流程"优先于"榨干裸数字式"。三个 DB 落地 eval（batch-modify / batch-modify-varied / multi-action）收紧后仍各 0 回归。全量 eval 新回归仅 meal-batch/query-plan 两条已知抖动（餐次继承 + 查询召回），均不在 modify/multi/record/删除/追加/撤销/exercise 流程内。

**结论分层**：后端路径 + 项级撤销 = 确定性铁（单测 + 变异测试）；模型判 multi = 清晰说法 ~99%、极简二义式偏保守但安全；相邻 record/单 modify 流程无回归。eval/parser 属概率性，线上仍靠 AiTrace 跟踪。

**目标**：让"玉米改为180克，瘦肉改为50克"这类**一句改多样、每样值不同**的消息真正改准，且改后的**每一条都能各自独立撤销**。

**依赖**：T45（multi 协议）、T47/T48（餐食卡撤销）
**关注文档**：AI_PARSING_SPEC §2/§8/§12（multi 边界）、DATA_MODEL（meal_card payload：last_change → last_changes）、API_SPEC（/records/:id/undo 语义不变，卡片撤销态项级）

## 背景（2026-07-05 真机翻车，AItrace 实锤）

用户 outoftoken 连续两条对照：
- ✅ `"吃了150克死面饼\n50克牛肉干"` → 模型判 `multi`（两个 record op），两条都入库。**multi + 新餐卡端到端已被生产验证。**
- ❌ `"玉米改为180克，瘦肉改为50克"` → 模型判 `modify` + **target 数组** `["r14","r13"]` + 单个 `change:{grams:180}`。target 数组只能配一个 change，瘦肉→50 从模型输出那刻就丢了；后端 `modify.ts` 批量分支只认 `change.meal_type`，其余**静默取 `refs[0]`**，只改了玉米。

三个缺陷叠加：
1. **模型抓错批量原语**：每条值不同本该走 `multi`（两 modify op），却用了只能配单一改动的 target 数组。
2. **后端静默丢弃**：`target` 数组 + 非 `meal_type` 的 change → 穿透到 `refs[0]` 只改第一条、其余无声吞掉（`modify.ts:27` 注释自认"不受支持，取第一条"）。
3. **撤销单槽**：餐卡 `last_change` 单槽，一轮 multi 双改后只有最后改的那条留在槽里，先改的撤销信息被覆盖（实测：玉米被瘦肉覆盖，玉米点撤销无效）。

## 设计要点

- **缺陷1（parser，主修）**：multi 提示词补"改A为X、改B为Y"→ 两个 modify op 的具体示例；`target` 数组规则收紧为**仅同一改动多条**（"以上都是早餐"，change.meal_type）；**每条值不同一律 multi**。
- **缺陷2（modify.ts，护栏）**：`refs.length > 1` 但非批量改餐次（无 `change.meal_type`）→ **绝不静默取首条**，明确降级：不动数据，提示用户分开说。数据一旦被模型压成单一 change 就无法恢复，后端只能让失败可见、不能兜底救回。
- **缺陷3（餐卡撤销，项级）**：`payload.last_change`（单槽）→ `payload.last_changes`（按 `record_id` 存多条，各自独立）。
  - `upsertMealCardMessage` 的 `lastChange` 参数改为指令式：`{op:"set",change}` 按 record_id 合并/替换、`{op:"clear",record_id}` 只删该条；其余记录的撤销态保留。
  - `enrichMealCards`：把已不在 items 里的陈旧撤销态剪掉（删除/移餐后自然清理）。
  - `/records/:id/undo`：撤销后只清**被撤销那条**的撤销态（`{op:"clear"}`），不再清空整卡。
  - append 撤销语义（无 prev_state = 删记录）在数组模型下保持不变。
  - 前端：`meal-card.tsx` 每个 item 独立判 `showUndo`（该条自己有 last_changes 项）；撤销态 `undoneCards`(按 messageId) → `undoneRecords`(按 record_id)，`exercise-card` 同步；旧 payload `last_change` 读时兼容（包成单元素数组）。

## 改动清单

- `backend/src/services/parser.ts`：multi 段加双 modify 示例 + target 数组边界收紧。
- `backend/src/services/intents/modify.ts`：缺陷2 护栏；update/append 的 lastChange 改指令式 set。
- `backend/src/services/meal-card.ts`：`last_change`→`last_changes`；merge/clear 指令；enrich 剪陈旧态；旧 payload 兼容。
- `backend/src/routes/records.ts`：undo 的 lastChange 改 `{op:"clear",record_id:id}`。
- `frontend/src/types/chat.ts`：`MealCardPayload.last_changes`（保留 last_change 读兼容）。
- `frontend/src/components/chat/meal-card.tsx`：项级 showUndo + undoneRecords。
- `frontend/src/components/chat/exercise-card.tsx`：undoneRecords 按 record_id。
- `frontend/src/stores/chat-store.ts`：undoneCards→undoneRecords（按 record_id），undo 签名去 messageId。
- `frontend/src/test/mocks.ts` + 相关组件测试：字段改名 + key 改 record_id。
- `backend/eval/cases/batch-modify.yaml`：新增回放（单/多/三食物批量改）。
- 单测：meal-card set/clear 合并、enrich 剪陈旧、modify 护栏、多 modify 各留独立撤销态。
- `docs/AI_PARSING_SPEC.md` / `docs/DATA_MODEL.md`：multi 边界 + last_changes 语义。

## 验收（覆盖单个 / 多个 / 三个食物）

1. **三食物批量改**：晚餐有 A/B/C，说"A改180、B改50、C改90"→ multi 三 op，DB 三条各自改对；餐卡一张、三项值全对；`last_changes` 三条，三项**各自都能撤销**、互不覆盖。
2. **两食物批量改**（截图现场回放）：玉米→180、瘦肉→50，两条都对；两项各自可撤销。
3. **单个食物改**：老路不回归——单条 modify 正常改 + 该条可撤销；单条撤销后其撤销态清除、其余不受影响。
4. **缺陷2 护栏**：若模型仍误吐 target 数组 + grams（非 meal_type），后端不改数据、给出"分别说"提示，绝不静默只改第一条。
5. **批量改餐次不回归**："以上都是早餐" 仍走 target 数组分支，双卡刷新正常。
6. **撤销串扰**：三食物批量改后，撤销 B → 只有 B 还原、A/C 撤销态与值不变；再撤销 A → A 还原、C 仍在。
7. `npm test`（前后端）全绿、`tsc`/类型检查零错误、全量 `npm run eval` 无新回归（multi/meal-batch 基线重点看）。
