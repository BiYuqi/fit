# T41 — 对话回归评测集：真实失败案例回放（对话智能）

**状态**：⬜待办

**目标**：把"翻 AiTrace → 对账 → 归因"的人肉排查固化成一条命令：回放录好的对话用例，逐轮断言意图 / 落库结果 / 回复红线，输出红绿表。改提示词、协议、上下文装配前后各跑一次，修东墙塌西墙当场现形。
**依赖**：无硬依赖，随时可做；建议先于或伴随 T36–T40 开工（它们的验收场景都应沉淀为用例）
**关注文档**：AI_PARSING_SPEC（意图协议）、AI_TRACE_SPEC、TEST_PLAN

## 背景（为什么会有这个任务）

现有 108 个测试全是确定性单测（计算、贝叶斯、组件），**没有一个能回答"DeepSeek 理解对了没有"**。2026-07-03 排查 outoftoken 用户对话（葱花饼案例）暴露：改一行提示词影响范围是黑盒——修好"无油款"可能顺手弄坏"我没放糖"。本系统的迭代模式是"排查记录 → 修 harness → 固化回归"，缺的就是"固化"这一步的载体。**不训练模型、不碰权重**，harness 修到哪，用例守到哪。

## 形态

`backend/eval/`（独立目录，不进 vitest/node:test 单测套件）：
- `cases/*.yaml`：一用例一文件，一段对话脚本。结构：
  ```yaml
  name: 葱花饼修正闭环（2026-07-03 outoftoken 真实案例）
  setup:                      # 可选：显式造前提状态（alias/bias/历史记录），不依赖账号残留
    food_alias: [{ canonical: "葱花饼", food: "葱花饼（无油）", streak: 2 }]
  turns:
    - say: "吃了100克葱花饼 煎的"
      expect:
        intent: record
        db: { food_record: { weight_g: 100, meal_type: dinner } }
    - say: "记录成180kcal"
      expect:
        intent: modify                       # T40 落地前此轮为红灯=已知缺陷
        db: { food_record: { calories: 180 } }
        reply_forbid: ["已更新(?!.*180)"]    # 没改成就不许说已更新
    - say: "今晚都吃了啥"
      expect: { intent: query, reply_contain: ["180"] }
  ```
- `run.ts`：回放器。逐用例 → 注册一次性账号 → 执行 setup 造数 → 逐轮 POST `/api/chat/message`（真实 DeepSeek）→ 断言 → 汇总红绿表。

## 关键设计决策（已定，执行时不再讨论）

1. **账号自动生成，每次运行新开**（如 `eval_<timestamp>`），不用固定账号——学习层（user_bias / user_food_alias / streak）和记忆层（ai_parse_log L0、近3日）会让老账号状态漂移，用例前提被污染（第一遍出候选卡、第二遍 alias 直连不出卡）。需要历史状态的用例在 `setup` 段显式造，前提写在纸面上。跑完账号留在本地库便于翻 AiTrace 排查红灯；提供 `--clean` 删除本次账号及其数据。
2. **断言结构化结果，不断言回复原文**。三类断言：意图（响应/ai_parse_log）、落库（food_record/pending_record/chat_message.kind 等事实表——核心）、回复红线（`reply_forbid` 禁词如只读路径的"已更新/已删除"、`reply_contain` 关键数字在场）。禁止全文相等断言。
3. **不进 CI，手动跑**（烧真实 token、有网络依赖与轻微随机性）：定位是"改 AI 相关代码前后各跑一次"。支持 `--case xxx` 跑单个用例。
4. **允许带红灯存在**：未修复缺陷对应的轮次标注 `known_fail: T40` 之类，输出时归入"已知缺陷"区别于"新回归"。红灯清单即已知缺陷清单。

## 首批用例（验收的一部分）

- `chunhuabing.yaml`：outoftoken 葱花饼 12 条完整回放（record→无油款→质疑→记录成180→查询→续加），T40 前相关轮标 known_fail。
- `zhidai.yaml`：指代与续报——"再来一碗"、"还有粽子"（餐次继承）、"那个改成小份"。
- `card-flow.yaml`：歧义候选卡 → resolve → 份量卡两步流（对齐 AI_PARSING_SPEC §4 现状）；T38 后补"文字应答卡片"轮。
- `guardrail.yaml`：红线集——"帮我算算这碗面多少卡"（不自算）、问无记录日期（明说无记录）、编程问题（拒答）、只读路径禁谎称。
- T36–T40 各任务验收里的场景，做完一个沉淀一个。

## 验收

- `npm run eval`（backend 内）跑通全部首批用例，输出每用例每轮红绿表 + 已知缺陷汇总；`--case` / `--clean` 可用。
- 同一用例连跑 2 遍结果一致（一次性账号保证状态隔离；轻微文本随机不影响结构化断言）。
- 故意改坏一条 parser 规则（如删掉续报餐次继承）→ 对应用例变红，其余不受影响（演示"塌西墙现形"）。
- 全程不改动生产代码路径；eval 目录不被单测套件加载。
- README（eval 目录内）：怎么加新用例、断言字段语义、known_fail 约定。
