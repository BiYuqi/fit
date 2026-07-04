# 对话回归评测集（T41）

回放真实对话用例，逐轮断言**意图 / 落库 / 回复红线**，输出红绿表。改提示词、意图协议、上下文装配前后各跑一次，防止修东墙塌西墙。**不进 CI**：烧真实 DeepSeek token（一整套几分钱）、有网络依赖与轻微随机性。

```bash
# 前提：./start.sh 已把后端起在 9300（或设 EVAL_API_BASE）
npm run eval                      # 跑全部用例
npm run eval -- --case chunhuabing  # 只跑一个
npm run eval -- --clean           # 跑完清理所有 eval_* 账号及其数据
```

## 机制

- 每次运行、每个用例**自动注册一次性账号**（`eval_<ts>_<rand>`）——学习层（bias/alias/streak）和 L0 记忆会让老账号状态漂移，绝不复用账号。
- 需要历史状态的用例在 `setup:` 段显式造数（如预插 streak=2 的 alias），前提写在纸面上。
- 账号默认留在库里（方便翻 AiTrace 排查红灯），`--clean` 一键删。

## 状态含义

| 图标 | 状态 | 含义 |
|---|---|---|
| ✅ | PASS | 通过 |
| ❌ | FAIL | **新回归**，进程退出码 1 |
| 🟡 | KNOWN | 有 `known_fail: Txx` 标记的已知缺陷，不算回归 |
| 🎉 | FIXED? | 标了 known_fail 却通过了——对应任务修复后请删掉标记 |

## 写用例

`cases/<name>.yaml`，一用例一段对话：

```yaml
name: 一句话说明（含来源，如真实用户案例日期）
profile: { weight_kg: 60 }          # 可选，覆盖默认档案
setup:                              # 可选，显式前提状态
  food_alias: [{ canonical: "葱花饼", food: "煎饼果子", streak: 2 }]
  food_record:                      # T44：种历史食物记录（days_ago 相对今天，1=昨天；用相对天数避免月初/周一日历边界抖动）
    - { days_ago: 1, food: "鸡蛋", grams: 60, meal_type: breakfast }
turns:
  - say: "中午吃了一碗米饭"          # 发消息
    known_fail: T40                 # 可选：已知缺陷归属
    expect:
      intent: record                # 或数组 [chat, discuss]（多路由都算合理时）
      reply_contain: ["180"]        # 全部子串须出现
      reply_contain_any: ["超出", "范围"]  # 至少一个
      reply_forbid: ["已删除"]       # 正则，命中即败（只读路径禁谎称等）
      db:
        food_record: { where: { food_name: "米饭" }, meal_type: lunch, calories: 180 }
        food_record_count: 1
        pending_record: { type: portion_choice }   # null 表示断言无 open pending
        last_card: candidate_card
  - resolve: { choice: medium }     # 模拟点卡片（对最新 open pending），choice 也可 { grams: 120 }
```

**断言纪律**：只断言结构化结果（意图、事实表、卡片种类）；回复文本只做禁词（`reply_forbid`）和关键数字在场（`reply_contain`）两种弱断言，**禁止全文相等断言**——AI 措辞每次都不同。数值断言容差 ±0.5（四舍五入口径）。
`db.food_record` 的数值字段除了精确值，也支持方向性比较器 `{ lt: N }` / `{ gt: N }`（可同时给两者）——AI 估算值（如属性修正后的新热量）具体数字不确定，只能断言方向（"比原值低"），见 T40 用例。还支持排除比较器 `{ ne: X }`——断言"不是某个值"（如餐次不得继承上文），见 meal-batch 用例。

**减少随机红灯的写法**：想固定餐次就在话里带时间词（"晚上吃了…"），想自动入库就给明确克数/个数，想触发份量卡就用"一碗/一盘"。多种路由都合理时 intent 写数组。

## 用例来源约定

1. 真实翻车对话（从 AiTrace / ChatMessage 抄原话）——修一个 bug，沉淀一个用例；
2. T36–T40 各任务验收场景，做完一个沉淀一个；
3. 未修复的缺陷轮标 `known_fail: Txx`，红灯清单即已知缺陷清单。
