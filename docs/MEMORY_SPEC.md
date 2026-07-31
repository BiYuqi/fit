# MEMORY_SPEC — 语义记忆系统（设计稿）

> 本文件是语义记忆系统的**设计文档**，尚未进入任务拆分。
> 与 LEARNING_SPEC 互补——那套学"你习惯吃多少"（数值偏差），这套学"你是谁"（语义事实）。

## 0. 定位与边界

| 维度 | LEARNING_SPEC（已有） | MEMORY_SPEC（本文档） |
|---|---|---|
| 学什么 | 用户**无意识**的行为模式（份量偏差） | 用户**有意识**表达的语义事实 |
| 数据源 | food_record 的 final_g vs predicted_g | 对话中的用户消息文本 |
| 评分方式 | 贝叶斯更新（先验 × 观测 → 后验） | 多维评分融合（类型先验 × 重复 × 衰减） |
| 产品层面 | 份量越来越准（用户无感） | AI 越来越懂用户（用户有感） |
| 错误代价 | 偏差 10-20% 用户无感 | 记错过敏/忌口可能严重 |

## 1. 铁律修正

原铁律 4：

> 食物匹配不用 embedding、不用向量库。用 DeepSeek 归一 + pg_trgm 模糊匹配。

修正为：

> **食物匹配**不用 embedding，用 DeepSeek 归一 + pg_trgm 模糊匹配。**语义记忆检索**使用 pgvector 做向量相似度召回——短字符串精确匹配与长文本语义检索是两类问题，需要的工具不同。

## 2. 核心设计原则

### 2.1 LLM 提取，系统评分（关注点分离）

```
用户消息
  │
  ├─ [LLM] Memory Extractor  →  "这句话说了什么事实？"（只提取，不做判断）
  │     输出: [{type, entity, content, llm_confidence, source}]
  │
  ├─ [确定性] Memory Scorer  →  "这个事实有多可靠、多重要？"（规则 + 数学）
  │     输入: LLM 输出 + 历史统计
  │     输出: scored candidates → 决策存/不存/更新
  │
  └─ [PG] Memory Store  →  写入 + 生成 embedding
```

LLM 擅长语义理解（"香菜"和"芫荽"是同一件事），但不擅长一致性判断（"这是用户第三次说这事了"）。系统擅长计数、衰减、阈值比较，但不擅长理解自然语言。各做各的。

### 2.2 类型决定衰减，评分决定状态

类型是记忆的**固有属性**——决定 λ（衰减速率）和注入行为。评分是记忆的**动态状态**——决定当前是否活跃。两者正交：

| | type=constraint | type=preference | type=habit | type=goal | type=context_state |
|---|---|---|---|---|---|
| λ (decay rate) | 0（不衰减） | 极小（数年） | 小（年级） | 大（月级） | 大（周级） |
| 注入格式 | "🚫 务必避开" | "偏好：…" | "习惯：…" | "目标：…" | "当前状态：…" |
| 评分阈值 | 低分也注入（安全优先） | 中高分才注入 | 中高分才注入 | 高分才注入 | 中分才注入 |
| 过期机制 | 无 | 纯衰减 | 纯衰减 | 衰减 + expires_at | 衰减 + expires_at |

### 2.3 乘法融合（任一因子归零则归零）

```
score = clamp(llm_confidence × type_weight(type) × repetition_boost(n) × decay(t), 0, 1)
```

为什么乘法而不是加权和：
- 加权和会让"没出现过的记忆"拿到 rule_score 撑起的虚假中等分
- 乘法保证：LLM 没提取到（0）、一次都没重复（接近0）、衰减到极致（接近0）→ 任一为零，score 直接归零
- 和 LEARNING_SPEC 的贝叶斯精神一致：先验精度 × 观测精度 → 后验，而非两者加权平均

## 3. 记忆类型

类型决定 λ、注入优先级、注入格式。五类形成从"永久"到"临时"的衰减光谱。

| 类型 | 含义 | 示例 | λ（衰减） | 注入格式 |
|---|---|---|---|---|
| **constraint** | 硬约束：安全/健康相关 | 过敏、疾病限制、宗教饮食 | 0 | "🚫 务必避开：…" |
| **preference** | 偏好：口味/食物喜好 | 不吃香菜、爱吃辣、口淡 | 0.001 | "偏好：…" |
| **habit** | 长期习惯：稳定行为模式 | 不吃早饭、每天喝咖啡、晚睡 | 0.002 | "习惯：…" |
| **context_state** | 临时状态：影响饮食但不是目标 | 出差中、压力大、节假日、生病恢复 | 0.015 | "当前状态：…" |
| **goal** | 短期目标：有时间边界 | 备赛期、本周控碳水、这个月戒糖 | 0.02 | "目标：…" |

> **ACTIVE 阈值的唯一定义处是 §8.1**（双阈值滞回）。本表刻意不列——历史上这里有过一张单阈值表，和 §8.1 打架，代码实现的是 §8.1。

λ 的含义：`decay = exp(-λ × days_since_last_access)`。λ=0 不衰减，λ=0.001 约 3 年衰减到 ~0.3，λ=0.002 约 1.5 年衰减到 ~0.33，λ=0.015 约 2 周掉出 ACTIVE、约 3 周到 ARCHIVED，λ=0.02 约 1 月衰减到 ~0.55。

> **context_state 的 λ 为什么是 0.015 而不是 0.005（T75 重标）**：原值按"出差中"、"备赛恢复期"这类周到月尺度的环境标定，但用户真正说出口的是「最近**3天**排便不畅」——日尺度。真机上一条 07-12 写入的临时状态到 07-27 仍是 ACTIVE 并被注入，按 0.005 要 **42 天**才掉出 ACTIVE。规范假设的时间尺度和实际语料差了一个数量级。

### context_state 与 goal 的区别

评审中提出的关键问题——"最近工作压力大，经常晚上 11 点吃东西"既不是 habit 也不是 goal：

| | context_state | goal |
|---|---|---|
| 本质 | 用户**身处**的环境 | 用户**设定**的方向 |
| 用户意图 | 被动（被环境推着走） | 主动（我要改变） |
| 示例 | 出差、压力期、节假日、生病 | 备赛、控碳水、戒糖 |
| 影响范围 | 推荐策略、热量容忍度、作息假设 | 热量目标、食物选择硬约束 |
| 衰减 | 较快（λ=0.015，约 2 周自然消退） | 快速（λ=0.02 + expires_at） |
| ACTIVE 阈值 | 见 §8.1 | 见 §8.1（门槛最高） |

context_state 解决的是：为什么这个月 AI 推荐不一样？因为用户状态变了，不是目标变了。

### 为什么是五类

- A 类（过敏/医疗/身份）→ constraint，共同点是"安全优先、不衰减、低分也注入"
- B 类（喜欢/讨厌/口味）→ preference，共同点是口味偏好，衰减极慢
- C 类（习惯/生活状态/短期目标）→ 拆为三种：
  - **habit**：稳定行为模式（年级衰减），"我一般…"、"我通常…"
  - **context_state**：被动身处的临时环境（周级衰减 + expires_at），"最近压力大…"、"出差中…"
  - **goal**：主动设定的有时间边界的目标（月级衰减 + expires_at），"这周控碳水…"
- D 类（不提取）→ 保留，放进 §4 的提取规则

三类拆成五种的理由：habit、context_state、goal 的生命周期和语义完全不同。用户"出差中"和"我要减脂"不能共用同一套衰减参数。

### 什么不是 memory（明确排除，和分类同等重要）

| 不提取 | 原因 | 示例 |
|---|---|---|
| 单次食物评价 | 评价的是菜，不是用户 | "这个面太油了"、"酱香饼太咸" |
| 瞬时情绪/状态 | 不持久 | "今天好累"、"没胃口" |
| 假设/愿望 | 不是事实 | "如果能戒掉宵夜就好了" |
| 对 AI 的纠正 | 走 LEARNING_SPEC | "你估太多了，应该100g" |
| 操作指令 | 是动作不是信息 | "把牛肉面改成大份" |
| 聊天寒暄 | 无信息量 | "谢谢"、"哈哈"、"好的" |
| 引用他人 | 不是用户自己的 | "我朋友说碳水不好" |
| 饮食记录本身 | 有 food_record | "中午吃了一碗面" |

核心启发式：**句子的逻辑主语是不是"我"（人）？在描述自己是持久的特征，还是在描述这次的食物/情绪？**

## 4. 提取管线

### 4.1 双层触发：同步 constraint + 异步 preference/habit/context_state/goal

```
用户消息
  │
  ├─ [同步] parse 主链路:
  │   ├─ 关键词快速扫描（~50 词，< 0.1ms）：
  │   │   命中 → LLM scope=constraint_only 提取
  │   │   未命中 → 跳过（"你好"、"今天吃了啥"不走 LLM）
  │   │   提取到 → 当场写 memory → 本轮后续立即可用（零窗口期）
  │   │   空列表 → 无副作用
  │   └─ ……正常回复用户……
  │
  └─ [异步 ~3-5s 后] 完整提取 job:
      ├─ 规则预筛选：最近 5 轮是否含任何记忆信号词？
      │   否 → 跳过，不调 LLM
      │   是 → 调 DeepSeek flash，scope=full
      ├─ 输入：最近 5 轮用户消息 + 已有最近 10 条 memory 摘要
      ├─ 输出：candidates [{type, entity, content, llm_confidence, source}]
      └─ → 送入 Scoring Engine（§5）→ 写入 user_memory
           → 下一次 buildMemoryPack 调用时自动可用（不保证当前回合）
```

为什么 constraint 走同步 + 关键词预筛选：
- 用户说"我对花生过敏"紧接着"推荐个零食"——异步提取还没跑完，AI 可能推荐花生制品。同步提取 + 立即可用于本轮 = 零窗口期。
- 纯关键词穷举不了所有表达，所以命中后走 LLM 做语义理解。但用关键词做第一层过滤，避免"你好"、"今天吃了啥"这类显然无关的消息也调 LLM。
- 关键词宁可松不可紧——漏筛代价是少记一条 constraint（安全风险），所以词表要覆盖常见过敏/疾病的多种口语表达（~50 词，见 §4.2 约束词表）。
- 异步提取的 memory 写入后，**下一次 `buildMemoryPack`** 调用时自动可用。不保证当前消息回合可用——constraint 以外的类型时效性要求低得多。

### 4.2 预筛选（不调 LLM，零成本）

**约束关键词**（同步路径第一层过滤，命中才调 LLM）：

```ts
const CONSTRAINT_KEYWORDS = [
  // 过敏相关（多种口语表达）
  "过敏", "过敏源", "起疹子", "起红疹", "肿了", "呼吸困难",
  "碰不得", "不能碰", "不能吃", "不能喝", "忌口", "忌",
  // 疾病/医疗
  "痛风", "糖尿病", "血糖", "血压", "高血脂", "脂肪肝",
  "乳糖不耐", "麸质", "胃酸", "胃炎", "胃溃疡", "肠胃",
  "腹泻", "拉肚子", "便秘", "消化不良",
  // 饮食身份/限制
  "素食", "吃素", "清真", "halal", "不吃猪肉", "不吃肉",
  "医生说", "营养师说", "体检", "报告", "查出",
];
```

命中任一关键词 → 调 constraint-only LLM。未命中 → 跳过。词表 ~50 词，覆盖常见过敏/疾病的多种口语表达，"碰花生会起疹子"命中"起疹子"，"乳糖不耐"命中"乳糖不耐"。

**异步 full 提取关键词**（见 §4.1，以下只用于异步路径）：

```ts
const FULL_TRIGGERS = [
  ...CONSTRAINT_KEYWORDS,  // 约束词作为异步二次确认
  // 偏好/口味
  "不吃", "讨厌", "喜欢", "爱吃", "习惯", "一般", "通常", "总是",
  // 阶段性状态/目标
  "最近在", "最近", "这周", "这个月", "备赛", "出差", "控碳", "戒", "少油", "少盐",
  "减肥", "增肌", "控糖", "生酮", "断食", "轻断食", "低碳",
  // 临时状态
  "压力", "焦虑", "加班", "熬夜", "生病", "不舒服", "旅游", "放假", "过年", "夜班",
];
```

异步宁可松不可紧——漏筛代价是少记一条偏好（可接受），误筛代价是调一次 LLM 返回空列表（~500 token，也可接受）。

### 4.3 LLM 提取 Prompt（概念）

```
你是记忆提取器。你的唯一任务是：从用户消息中提取"关于用户自己的持久事实"。
**大部分时候返回空列表。** 不要有压力——空列表是正常的。

## 提取类型

### constraint（硬约束——安全/健康相关）
- 过敏: "我对花生过敏" → {type: "constraint", entity: "peanut", content: "花生过敏"}
- 医疗限制: "痛风不能吃高嘌呤" → {type: "constraint", entity: "high_purine", content: "痛风，需低嘌呤饮食"}
- 宗教/身份饮食: "我是素食者" → {type: "constraint", entity: "vegetarian", content: "素食者"}

### preference（偏好——口味/食物喜好）
- 讨厌: "我不吃香菜" → {type: "preference", entity: "cilantro", content: "不吃香菜"}
- 喜爱: "我超爱吃辣" → {type: "preference", entity: "spicy", content: "喜欢辣味"}
- 口味倾向: "我口淡，少油少盐" → {type: "preference", entity: "light_taste", content: "口味偏清淡，少油少盐"}

### habit（长期习惯——稳定行为模式，不会随时间自然改变）
- 饮食节奏: "我早上一般不吃早饭" → {type: "habit", entity: "skip_breakfast", content: "通常不吃早餐"}
- 饮品习惯: "我每天都要喝咖啡" → {type: "habit", entity: "coffee", content: "每天喝咖啡"}
- 作息: "我晚上睡得晚" → {type: "habit", entity: "late_sleeper", content: "晚睡"}

### context_state（临时状态——被动身处的环境，影响饮食但不是目标）
- 工作: "最近出差，吃饭不规律" → {type: "context_state", entity: "business_trip", content: "出差中，饮食不规律"}
- 压力: "最近工作压力大，晚上总想吃东西" → {type: "context_state", entity: "stress_period", content: "压力期，夜间食欲增加"}
- 节假日: "过年这几天放开吃了" → {type: "context_state", entity: "holiday_mode", content: "节假日模式"}
- 伤病: "最近胃炎，只能吃清淡的" → {type: "context_state", entity: "illness_recovery", content: "胃炎恢复期，需清淡饮食"}
- 作息变化: "最近上夜班，吃饭时间全乱了" → {type: "context_state", entity: "night_shift", content: "夜班期，饮食时间异常"}

**区分 context_state 还是 goal**：
- 被动描述环境/状态 → context_state（"出差中"、"压力大"、"生病了"）
- 主动设定方向/目标 → goal（"备赛"、"控碳水"、"戒糖"）

### goal（短期目标——有时间边界，过期后不再有效）
- 生活状态: "最近在备赛" → {type: "goal", entity: "competition_prep", content: "备赛期"}
- 短期目标: "这周控碳水" → {type: "goal", entity: "low_carb", content: "本周控制碳水摄入", expires_in_days: 7}
- 明确时限: "这个月戒糖" → {type: "goal", entity: "no_sugar", content: "本月戒糖", expires_in_days: 30}

**区分 habit 还是 goal 的关键判断**：
- 用户给了时间限定（"这周"、"这个月"、"到月底"、"最近"）→ goal，并提取 expires_in_days
- 用户描述的是"一直如此"的稳定模式（"一般"、"通常"、"总是"、"每天"）→ habit
- 拿不准时选 habit——宁可让短期目标多活几天，也别让长期习惯被快速衰减误杀

## 提取规则

1. 每条 memory 必须引用原文（source 字段）。
2. llm_confidence ∈ [0,1]：你对"这是一条真实的用户特征"的把握度。
   - 0.90+：用户明确陈述，语义清晰
   - 0.80-0.90：用户明确陈述，但可能有夸张/修辞
   - 0.70-0.80：有信息量但不够明确——可能提取，交给评分系统裁决
   - <0.70：不输出
3. 主语启发式：句子主语是"我"（人）→ 可能提取；主语是"这个/那个"（食物/事情）→ 不提取。
4. 不推断、不猜测、不脑补用户没说的话。
5. entity 归一化：使用下方的受控词表。匹配已有 entity，没有的才新建。新建 entity 用 snake_case 英文。
6. 如果已存记忆中有同 entity+type 的 → action: "update"，否则 → action: "create"。
7. importance_class ∈ {medical, strong, normal, casual}：这个事实对用户饮食决策的影响程度。
   - medical：安全/医疗级（过敏、疾病、药物相互反应）——系统映射 importance=1.3
   - strong：重要偏好或强习惯（"每天必须喝咖啡"、"晚上吃多胃不舒服"）——系统映射 importance=1.1
   - normal：普通偏好/习惯/状态——系统映射 importance=1.0
   - casual：随口提及，不太确定是不是认真的——系统映射 importance=0.85

   为什么是分类而非连续值：LLM 输出 0.8-1.3 的连续值方差太大——"这个很重要"有时给 1.2 有时给 1.3，评分引擎需要确定性。分类 + 系统映射保证同一事实每次提取的 importance 一致。

## 受控 Entity 词表（优先匹配，没有的才新建）

| entity | 覆盖表达 |
|---|---|
| cilantro | 香菜、芫荽、cilantro、coriander |
| spicy | 辣、吃辣、辣味、辣椒、麻辣、香辣 |
| peanut | 花生、peanut、花生米 |
| seafood | 海鲜、虾、蟹、鱼、贝壳、蛤蜊、扇贝 |
| dairy | 奶、牛奶、乳制品、奶酪、酸奶、芝士、奶油 |
| gluten | 麸质、面筋、小麦、面粉 |
| soybean | 大豆、黄豆、豆腐、豆浆、豆制品 |
| light_taste | 口淡、清淡、少油、少盐、不油腻 |
| sweet | 甜食、甜点、糖、爱吃甜的、奶茶 |
| skip_breakfast | 不吃早饭、不吃早餐、跳过早餐、早上不饿 |
| vegetarian | 素食、吃素、不吃肉 |
| halal | 清真、halal、不吃猪肉 |
| alcohol | 酒、喝酒、酒精、啤酒、白酒、红酒 |
| coffee | 咖啡、美式、拿铁、浓缩 |
| competition_prep | 备赛、比赛准备、赛期 |
| low_carb | 控碳水、低碳、戒碳水、少吃主食 |
| weight_loss | 减肥、减脂、瘦身、控制体重 |
| intermittent_fasting | 断食、轻断食、16+8、不吃晚饭 |
| business_trip | 出差、外勤、不在家吃 |
| stress_period | 压力大、焦虑、加班多、熬夜工作 |
| holiday_mode | 节假日、过年、放假、旅游 |
| illness_recovery | 生病、胃炎、术后恢复、身体不适 |
| night_shift | 夜班、倒班、通宵、作息颠倒 |

## 绝不提取

- 单次食物评价（"这个面太油了"——在评价菜，不是说自己）
- 瞬时情绪/状态（"今天好累"）
- 假设/愿望（"如果能戒掉宵夜就好了"）
- 对 AI 的纠正（"你估太多了"——走学习系统）
- 操作指令（"把牛肉面改成大份"）
- 聊天寒暄（"谢谢"、"哈哈"）
- 引用他人（"我朋友说碳水不好"）

## 已有记忆（用于去重，最多 10 条）
[entity + type 列表，不含完整内容]
```

### 4.4 LLM 输出 Schema（strict tool）

```json
{
  "candidates": [
    {
      "type": "constraint | preference | habit | context_state | goal",
      "entity": "cilantro",
      "content": "不喜欢吃香菜",
      "llm_confidence": 0.92,
      "importance_class": "normal",
      "source": "我不吃香菜，凉菜里别放",
      "expires_in_days": null
    }
  ]
}
```

LLM 输出的是 **`expires_in_days`（相对天数，正整数或 null）**，`context_state` 和 `goal` 都填，其余三类不填。绝对时刻由后端 `upsertMemory` 换算成 `expires_at` 落库。

> **为什么不让 LLM 直接给绝对日期（T75）**：两条提取路径的 prompt 都不含"今天是几号"（提取是独立 LLM 调用，不走 chat 的上下文压缩）。让模型填 ISO 日期，它只会照抄 few-shot 里的字面量，产出一个**已经过去**的日期——叠加 §7.1 检索层的过期过滤，新记的记忆会一出生就过期、永不注入、且零报错。相对天数把日历算术从模型手里拿走了，同时 prompt 里不再需要拼当天日期。

未给 `expires_in_days` 时后端按类型兜底：`context_state` **14 天**（与 λ=0.015 掉出 ACTIVE 的时间对齐，两条机制不打架）；`goal` **不兜底**（首次 goal 的分数上限 `0.9 × 0.80 × rep_boost(1)` = 0.504 < `ACTIVE_UP.goal` 0.65，本就进不了 ACTIVE，兜底是给死代码加死代码）；其余三类语义即长期，不引入 TTL。

注意：LLM **不输出** score、不判断存不存、不决定最终状态。只负责"提取事实"。

## 5. 评分引擎（Scoring Engine）

### 5.1 评分公式

```
score = clamp(
  llm_confidence          ← LLM 的初始把握度
  × type_weight(type)     ← 类型先验
  × importance            ← 事实本身的重要性（LLM 输出 class → 系统映射为确定值）
  × repetition_boost(n)   ← 重复强化（说过越多次越可信）
  × decay(t)              ← 时间衰减（越久远越不可信）
, 0, 1)
```

### 5.2 各项定义

**type_weight**——类型先验：

| type | weight | 理由 |
|---|---|---|
| constraint | 1.0 | 用户不会拿过敏/疾病开玩笑 |
| preference | 0.90 | 明确偏好通常真实，但可能有夸张 |
| context_state | 0.88 | 临时状态通常是被动描述的，较真实 |
| habit | 0.85 | "通常"、"一般"不保证每次都如此 |
| goal | 0.80 | 目标最容易随口一说然后放弃 |

**importance**——事实本身的重要程度。LLM 输出离散 class，系统做确定性映射（与 type_weight 正交）：

| importance_class | 系统映射 | 含义 | 示例 |
|---|---|---|---|
| medical | 1.3 | 安全/医疗级 | 过敏、疾病、药物相互反应 |
| strong | 1.1 | 重要偏好或强习惯 | "每天必须喝咖啡"、"晚上吃多胃不舒服" |
| normal | 1.0 | 普通 | 大多数偏好/习惯/状态 |
| casual | 0.85 | 随口提及 | 不太确定是不是认真的 |

为什么用 class 而非连续值：LLM 输出连续值（0.8-1.3）方差大——"这个很重要"有时给 1.2 有时给 1.3，评分引擎需要确定性。分类 + 系统映射保证同一事实每次提取的 importance 值一致。这也是关注点分离的延续——LLM 做语义判断（medical/strong/normal/casual），系统做数值映射（1.3/1.1/1.0/0.85）。

importance 解决的问题：rep_boost(n=1)=0.70 对所有类型一视同仁，但"花生过敏"第一次说和"爱吃辣"第一次说的重要性完全不同。importance 让关键事实第一次就能拿到接近满分的权重，不依赖重复确认。

**repetition_boost**——重复强化：

```
repetition_boost(n) = 1 - exp(-1.2 × n)

n=1 → 0.70   (第一次说，温和折扣)
n=2 → 0.91   (第二次说，接近满)
n=3 → 0.97   (第三次说，基本确信)
n=4+→ →1.0   (饱和)
```

n 的计数规则：
- 每次 extraction 命中已有 entity+type 时 `repetition_count += 1`
- **24h 去重**：同一 entity 在 24 小时内多次提及只计一次。由 scoring engine 在更新时检查 `last_accessed_at`——若距上次更新 < 24h，不递增。防止同一件事在澄清对话中被反复提及 5 次直接拉到饱和。

α=1.2 使得单次提及保留 70% 权重——用户明确说了一次"不吃香菜"，不至于被系统性压到 WEAK 底部。二次确认后迅速收敛到 0.91，三次后基本等同于确信。折扣曲线陡峭意味着"从0到1"这一步是最大的跃迁，后续递减极快——这与实际的信号可靠性一致：第一次提及的信息量最大，第二次是验证，第三次以上是冗余。

**decay**——时间衰减：

```
decay(t) = exp(-λ(type) × Δt)

λ(constraint)     = 0        → 不衰减（过敏不会自愈）
λ(preference)     = 0.001    → 1 年后 ~0.70，3 年后 ~0.33
λ(habit)          = 0.002    → 1 年后 ~0.48，1.5 年后 ~0.33
λ(context_state)  = 0.015    → 14 天后 ~0.81（score 跌破 ACTIVE_DOWN），30 天后 ~0.64
λ(goal)           = 0.02     → 1 个月后 ~0.55，2 个月后 ~0.30
```

Δt = 当前时间 - `last_accessed_at`（**上次被用户提及或更新**的时间，不是 created_at）。每次用户再次提及，last_accessed_at 刷新，decay 拉回 1.0。

> **系统检索注入不刷新 `last_accessed_at`（T75，反直觉但刻意）**：一旦注入就刷新，任何被注入过的记忆 decay 会永远重置回 1.0，陈旧记忆将**永生**，而且越是被反复注入的（也就是最影响对话的那些）越不会消失。别"补全"这条——`updateAccessTime()` 曾作为零调用死代码存在，已在 T75 删除。

### 5.3 决策规则

不同类型有各自的 ACTIVE 阈值（唯一定义处见 §8.1 双阈值滞回表）。统一规则：

```
score ≥ ACTIVE_THRESHOLD[type]  → state = ACTIVE   → 检索时注入上下文
0.40 ≤ score < ACTIVE_THRESHOLD  → state = WEAK    → 保留但不注入（观察中，等更多证据）
score < 0.40                     → state = ARCHIVED → 不注入，不参与检索
```

constraint 的晋升阈值（0.48）低于 preference（0.55）——安全性通过参数实现，不通过旁路。同一套评分引擎、同一套决策逻辑，不同类型的参数配置不同。这消除了"特殊规则绕过评分引擎"的问题——所有类型的决策走同一套评分引擎、同一套逻辑，只是参数配置不同。

ARCHIVED 的 0.40 底线对所有类型相同——低于此线意味着 LLM 本身就不太确定（llm_confidence < 0.70）且没有被重复强化过，无论什么类型都不该注入。

### 5.4 示例演算

> 阈值一律用 §8.1 的双阈值滞回（`ACTIVE_UP` 晋升 / `ACTIVE_DOWN` 降级），下面每个场景都是**从 WEAK 起步判晋升**，所以比的是 `ACTIVE_UP`。

**场景 1：用户第一次说"我对花生过敏"**

```
llm_confidence = 0.95
type_weight(constraint) = 1.0
importance_class = medical → 1.3   ← 安全/医疗级
repetition_boost(1) = 0.70
decay(0) = 1.0

score = 0.95 × 1.0 × 1.3 × 0.70 × 1.0 = 0.86
→ ACTIVE_UP(constraint) = 0.48 → ACTIVE ✓（importance 1.3 补偿了首次折扣）
→ 对比 importance=1.0：0.95 × 1.0 × 0.70 = 0.67，提升 28%
```

**场景 2：用户第一次说"我超爱吃辣"**

```
llm_confidence = 0.85
type_weight(preference) = 0.90
importance_class = normal → 1.0    ← 普通偏好
repetition_boost(1) = 0.70
decay(0) = 1.0

score = 0.85 × 0.90 × 1.0 × 0.70 × 1.0 = 0.54
→ ACTIVE_UP(preference) = 0.55 → **WEAK**（差 0.01，再提一次就 ACTIVE）
```

**场景 3：用户第三次说"不吃香菜"，跨度 2 个月**

```
llm_confidence = 0.90
type_weight(preference) = 0.90
importance_class = normal → 1.0
repetition_boost(3) = 0.97
decay(60天) = exp(-0.001 × 60) = 0.94

score = 0.90 × 0.90 × 1.0 × 0.97 × 0.94 = 0.74
→ ACTIVE_UP(preference) = 0.55 → ACTIVE ✓（稳固）
```

**场景 4：用户第一次说"最近出差饮食不规律"**

```
llm_confidence = 0.85
type_weight(context_state) = 0.88
importance_class = normal → 1.0
repetition_boost(1) = 0.70
decay(0) = 1.0

score = 0.85 × 0.88 × 1.0 × 0.70 × 1.0 = 0.52
→ ACTIVE_UP(context_state) = 0.55 → **WEAK**（首次不够，再提一次才进）
→ 若 llm_confidence = 0.90：score = 0.554 → 刚过 0.55 → ACTIVE
→ 14 天后不重复：decay(14) = exp(-0.015 × 14) = 0.81，score = 0.449 → 跌破 ACTIVE_DOWN 0.45 → WEAK
```

**场景 5：用户第一次说"我早上一般不吃早饭"，2 个月没再提**

```
llm_confidence = 0.85
type_weight(habit) = 0.85
importance_class = normal → 1.0
repetition_boost(1) = 0.70
decay(60天) = exp(-0.002 × 60) = 0.887

score = 0.85 × 0.85 × 1.0 × 0.70 × 0.887 = 0.449
→ ACTIVE_UP(habit) = 0.58 → WEAK（差一点，再提一次就 ACTIVE）
```

**场景 6：用户半年前说"最近在备赛"，之后再没提过**

```
llm_confidence = 0.80
type_weight(goal) = 0.80
importance_class = normal → 1.0
repetition_boost(1) = 0.70
decay(180天) = exp(-0.02 × 180) = 0.027

score = 0.80 × 0.80 × 1.0 × 0.70 × 0.027 = 0.012
→ 远低于 ARCHIVED 底线 0.40 → ARCHIVED（自动沉底）
```

**场景 7：用户说"这周控碳水"，2 周后（已过期）**

> 过期记忆**首先**被 §7.1 的检索 SQL 直接挡在外面，根本不进上下文；下面的 × 0.2 是让凌晨的 `recalcAndPrune` 把 `state` 落库对齐。两者是同一件事的即时面和持久面（T75）。

```
llm_confidence = 0.80
type_weight(goal) = 0.80
importance_class = normal → 1.0
repetition_boost(1) = 0.70
decay(14天) = exp(-0.02 × 14) = 0.756
expires_at 已过 → × 0.2 = 0.151

score = 0.80 × 0.80 × 1.0 × 0.70 × 0.151 = 0.068
→ ARCHIVED ✓（过期目标自动崩盘）
```

**场景 8：用户第一次说"晚上吃多了胃不舒服"，importance=1.2**

```
llm_confidence = 0.85
type_weight(preference) = 0.90
importance_class = strong → 1.1    ← 接近医疗级（影响健康）
repetition_boost(1) = 0.70
decay(0) = 1.0

score = 0.85 × 0.90 × 1.1 × 0.70 × 1.0 = 0.589
→ ACTIVE_UP(preference) = 0.55 → ACTIVE ✓（importance 补偿首次折扣）
→ 对比 importance=1.0：score = 0.54，提升 9%
```

### 5.5 冲突处理

当 extraction 产出的 entity+type 命中已有记忆时，scoring engine 在写入前执行：

**Step 1 — 语义比较（调 LLM，极轻量）**：
```
输入：旧 content + 新 content
输出：{ relation: "same" | "similar" | "opposite" }
```

**Step 2 — 按 relation 分派**：

```
same/similar → update（更新 content、刷新 last_accessed_at、repetition_count += 1）
opposite → 冲突：
    if llm_confidence_new > llm_confidence_old + 0.10
       AND new_score > old_score                  ← 新记忆综合评分也更高
       AND new.valid_from > old.valid_from:       ← 新记忆时间上在后（用户确实变了）
        replace（旧记忆设 valid_to = now()，新记忆设 valid_from = now()）
    else:
        旧记忆 score 减半（降权但不删除）
        新记忆正常入库，score 按公式正常计算
        两条共存，由检索时的 score 自然裁决
```

不引入 `contradicted` 状态——冲突通过 score 的数学机制自然解决：旧记忆降权后可能落入 WEAK 或 ARCHIVED，新记忆如果持续被强化则升为 ACTIVE。如果两条都掉到 ARCHIVED，说明用户自己也不一致，系统不做强行裁断。

注意：语义比较是 scoring engine 在写入前专门调的一次极轻量判断（单条 ~100 token），不是 extraction 时顺手做的。extraction 只负责提取事实，不负责比较。

#### 实现注记（T74，2026-07-28）——实际走的不是上面的 Step 1/2

上面的 Step 1/2 保留为设计记录，**代码没有按它实现**，且不打算实现。实际落地的是两件事：

**1. entity 级 upsert 取代"语义比较"**。冲突键从 `(user_id, type, entity, content)` 收窄到 `(user_id, type, entity)`（migration `20260728010000_t74_memory_entity_unique`）。同 entity 的新措辞直接 `DO UPDATE` 覆盖 `content`、累加 `repetition_count`——「最近3天排便不畅」和「排便已恢复正常」不再是两行互相打架。Step 1 那次 LLM 语义比较因此变成纯增量成本（往调用链里加不是往外减，与 T63 否掉 Router+Specialist 同理），不做。

**2. 显式 `invalidations` 通道取代"opposite 分派"**。§5.5 只处理"新旧两条矛盾"，覆盖不了**纯否认**——「我排便正常了，你是不是记错了」否定一条旧记忆但不产生任何值得存的新事实，走 §5.5 会退化成"提取不出候选 → 什么都不做"。所以提取输出新增与 `candidates` 并列的 `invalidations` 数组，形状是"指向哪条已有记忆"而非"存什么内容"：

```ts
{ type, entity, reason, llm_confidence }   // entity 必须来自喂给模型的【已有记忆】列表
```

处理规则（`invalidateMemory()`，`memory-store.ts`）：

| 情况 | 结果 |
|---|---|
| `importance_class = 'medical'` | **只降权**（`llm_confidence` 折半，地板 0.30），返回 `demoted` |
| `llm_confidence < 0.80` | 同上，返回 `demoted` |
| 其余 | `valid_to = now()` + `state = 'ARCHIVED'`，`source_text` 追加原话，返回 `invalidated` |
| entity 不在喂进去的列表里 | `not_found`，静默忽略（防模型幻觉抹掉真记忆） |

`valid_to` 至此才有第一个写入方——T54 建的这个字段在 T74 之前零写入。ARCHIVED 后 90 天由 `deleteExpiredMemories` 周 cron 自然清理，期间用户在记忆中心仍能看到。

**医疗地板是硬底线**：`decideStateWithFloor()` 保证 `medical` 记忆**任何自动路径**（作废降权、每日 recalc cron、写入时定状态）都只能降到 `WEAK`，`ARCHIVED` 只有用户在记忆中心手动做。LLM 分不清"我不过敏了"和"我这次吃了没过敏"，误删一条花生过敏和误删一条"最近出差"差着几个数量级。发生降权时，本轮回复会带一条【记忆提示】引导用户去记忆中心手动删。

**作废走同步路径**（`quickExtract`）：用户说"你记错了"之后下一句就可能重问同一个问题，异步 `fullExtract` 在响应返回后才跑，会导致同一轮对话里 AI 再说一遍错话。代价是 `quickExtract` 也要 `loadActiveMemories` 一次（作废必须知道有哪些记忆可作废）。

**预筛选也得改**：`CONSTRAINT_KEYWORDS` 整张表描述的都是"用户在**陈述**一个事实"，否认长成另一个样子——「我排便正常了，你是不是记错了」一个词都不命中，`quickExtract` 根本不会被调起。因此新增并列的 `DENIAL_KEYWORDS`（记错/正常了/早就/结束了/…），两张表合成一道闸门 `hasMemorySignal()`。

## 6. 存储模型

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE user_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  type VARCHAR NOT NULL CHECK (type IN ('constraint', 'preference', 'habit', 'context_state', 'goal')),
  entity VARCHAR NOT NULL,          -- 归一化实体，使用 §4.3 受控词表
  content TEXT NOT NULL,            -- 人类可读文本，供 LLM 上下文注入

  llm_confidence REAL NOT NULL,     -- LLM 初始把握度（提取时记录，不变）
  importance_class VARCHAR NOT NULL DEFAULT 'normal',  -- LLM 判断的等级 → 系统映射为确定值
    -- CHECK (importance_class IN ('medical', 'strong', 'normal', 'casual'))
  repetition_count INTEGER NOT NULL DEFAULT 1,  -- 累计被提及次数（24h 去重）
  state VARCHAR NOT NULL DEFAULT 'WEAK',  -- ACTIVE | WEAK | ARCHIVED

  source_type VARCHAR NOT NULL DEFAULT 'explicit_user',  -- explicit_user | implicit_behavior | system_inferred
  -- v1 只写入 explicit_user；implicit_behavior 和 system_inferred 预留给行为推断（§11）

  expires_at TIMESTAMPTZ,           -- context_state/goal 的过期时刻：过期后不进检索 + score × 0.2（T75）
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 此记忆开始有效的时间
  valid_to TIMESTAMPTZ,             -- 此记忆被新矛盾记忆取代的时间（冲突处理时填写）

  embedding vector(1024),           -- DeepSeek embedding 模型输出（1024 维）

  source_message_id UUID,           -- 追溯
  source_text TEXT,                 -- 追溯：原文片段

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, type, entity)
  -- T74 起收窄（原为含 content 的四元组）：同 entity 只留一行，新措辞覆盖旧措辞。
  -- 含 content 的旧键会让「最近3天排便不畅」和「排便已恢复正常」变成两条独立的行——
  -- repetition_count 不累加、旧措辞永远留在库里和新的打架。实现注记见 §5.5。
  -- 冲突 replace 时：旧记忆设 valid_to = now()，新记忆设 valid_from = now()——保留用户变化轨迹
);

-- 注意：score 不存储在表中，检索时在应用层实时计算（纯数学，极快）。
-- 仅在跨阈值边界时写 state 字段，避免每次检索触发写放大。
-- 如需排序或过滤，在 SELECT 中用表达式计算。

CREATE INDEX idx_user_memory_state ON user_memory(user_id, state);
CREATE INDEX idx_user_memory_last_access ON user_memory(user_id, last_accessed_at);
CREATE INDEX idx_user_memory_embedding ON user_memory
  USING hnsw (embedding vector_cosine_ops);
  -- HNSW 适合小数据量高并发场景；若用户量少也可用 ivfflat
```

设计要点：
- 不用 `key` 字段，改用 `(user_id, type, entity)` 联合唯一约束——同 type 同 entity 只留一行，新措辞覆盖旧措辞（T74 收窄，理由见 §5.5 实现注记）。跨 type 仍可共存（如"不吃香菜"preference + "在尝试接受香菜"goal）
- 不用 `ttl_days`，衰减由 scoring engine 的 decay 函数统一管理
- 不用 `structured` jsonb（当前数据规模不需要结构化子字段）
- `state` 取值 ACTIVE / WEAK / ARCHIVED，带双阈值滞回防止震荡
- `repetition_count` 作为 scoring 的一级输入，24h 内同 entity 多次提及只计一次
- `score` **不落库**——检索时在应用层实时计算（纯数学，极快）。只在跨阈值边界时写 `state`，避免每次检索触发全量 UPDATE 写放大
- `importance_class` LLM 只做语义分类（medical/strong/normal/casual），系统做确定性数值映射（1.3/1.1/1.0/0.85）——避免 LLM 连续值方差破坏评分引擎确定性
- `source_type` 预埋——v1 只有 explicit_user，后续行为推断走 implicit_behavior/system_inferred
- `valid_from` / `valid_to` 保留用户变化轨迹——冲突时不删旧记忆，标注有效时间区间。`valid_to` 的唯一写入方是 T74 的作废通道（`invalidateMemory`）
- **审计追溯**：`source_message_id` + `source_text` + `llm_confidence` + `importance_class` + `created_at` 五字段构成完整审计链，线上出现"为什么 AI 觉得我不吃早餐"时可直接定位到原始消息和提取参数，无需翻聊天记录
- `embedding` 使用 DeepSeek embedding 模型（1024 维），与 LLM 提取同供应商，降低延迟和成本

## 7. 检索与注入

### 7.1 检索流程（混合检索）

Memory 不是知识库——它是用户身份参数。不同场景需要不同类型的记忆，纯 embedding 召回会把 constraint 淹没在 preference 里。

```
用户最新消息
  │
  ├─ [确定性] constraint 全量拉取：
  │   SELECT * FROM user_memory
  │   WHERE user_id = $1 AND state = 'ACTIVE' AND type = 'constraint'
  │   → 全部注入（安全优先，不走 embedding，不受 top-5 限制）
  │
  ├─ [确定性] context_state + goal 场景匹配：
  │   SELECT * FROM user_memory
  │   WHERE user_id = $1 AND state = 'ACTIVE' AND type IN ('context_state', 'goal')
  │   → 按 score DESC，取 top-3
  │   → 目标/状态按 score 排序即可，不需要语义匹配——它们是对当前场景的全局覆盖
  │
  ├─ [语义] preference + habit embedding 召回：
  │   SELECT * FROM user_memory
  │   WHERE user_id = $1 AND state = 'ACTIVE' AND type IN ('preference', 'habit')
  │   ORDER BY embedding <=> $2
  │   LIMIT 5
  │   → 偏好和习惯需要语义匹配——"推荐晚餐"应该召回到"喜欢牛肉"而非"喜欢甜食"
  │
  └─ 合并去重 → 注入 compressContext
      总条数控制在 constraint 全量 + 最多 8 条其他
```

分层理由：
- **constraint 永远全量注入**：5 条 constraint 只占 ~100 token，漏一条可能推荐过敏食物。embedding 召回本质是"相似度排序 + top-N 截断"，可能把排在 #6 的过敏截掉——不可接受
- **context_state/goal 按 score 排序**：它们是全局状态描述，"出差中"和"推荐晚餐"没有语义匹配关系，但就是应该被考虑。按 score 降序取 top-3 足够
- **preference/habit 用 embedding**：偏好需要场景关联——"推荐晚餐"和"喜欢牛肉"有语义关联，"推荐早餐"和"不吃早饭"有语义关联。这是 embedding 的正确用法

### 7.2 注入格式

在 `compressContext` 的【用户档案】下方插入：

```
【关于你】
  🚫 务必避开：花生过敏（食用后过敏）
  偏好：喜欢辣味，不喜欢香菜
  习惯：通常不吃早餐
  当前状态：出差中，饮食不规律（2 周前更新）
  目标：备赛期（3 个月前更新，可能已过期）

【用户档案】…（现有 L2）
【今日进度】…（现有 L2）
...
```

注入规则：
- constraint 加 `🚫 务必避开` 前缀，全部注入，永远排最前
- preference 加 `偏好：`
- habit 加 `习惯：`
- context_state 加 `当前状态：`，且如果 `last_accessed_at > 30 天前`，追加 `（N 天前更新）`
- goal 加 `目标：`，且如果 `last_accessed_at > 30 天前` 或 `expires_at` 已过，追加 `（可能已过期）`
- constraint 以外最多 8 条，总 token 预算 ~300
- 按 score 降序排列

### 7.3 检索时机

每次构建 ContextPack（`buildMemoryPack`）时执行。三层查询（constraint 全量 + context_state/goal 按 score + preference/habit embedding）在 PG 本地完成，数据量几十到百条，延迟 ~3-8ms，可内联无需缓存。

## 8. 生命周期管理

### 8.1 状态流转

```
         ┌──────────┐
         │  WEAK    │ ← 初始状态（新记忆从此起步）
         └────┬─────┘
              │ scoring: score ≥ ACTIVE_UP[type]（晋升阈值，见下表）
         ┌────▼─────┐
         │  ACTIVE   │ ← 注入上下文
         └────┬─────┘
              │ scoring: score < ACTIVE_DOWN[type]（降级阈值）
         ┌────▼─────┐
         │  WEAK     │ ← 保留观察
         └────┬─────┘
              │ scoring: score < 0.40（所有类型统一的 ARCHIVED 底线）
         ┌────▼─────┐
         │ ARCHIVED  │ ← 不参与检索
         └──────────┘
              │ 每周 cron：ARCHIVED 且 created_at > 90 天
         ┌────▼─────┐
         │  硬删除   │
         └──────────┘
```

双阈值（滞回控制）：

| 类型 | ACTIVE_UP（晋升） | ACTIVE_DOWN（降级） | 死区宽度 |
|---|---|---|---|
| constraint | 0.48 | 0.40 | 0.08 |
| preference | 0.55 | 0.45 | 0.10 |
| context_state | 0.55 | 0.45 | 0.10 |
| habit | 0.58 | 0.48 | 0.10 |
| goal | 0.65 | 0.55 | 0.10 |

晋升阈值比降级阈值高 0.05-0.10，形成死区。score 在死区内波动时状态不变，防止 WEAK↔ACTIVE 反复震荡。约束类型的死区更窄（0.08），因为其 decay=0 不存在自然衰减导致的波动，更宽的缓冲区无意义。

ACTIVE_UP 阶梯：constraint(0.48) < preference(0.55) = context_state(0.55) < habit(0.58) < goal(0.65)——越不确定、越容易随口说的类型，晋升门槛越高。context_state 和 preference 同级——用户描述自己的临时状态通常不会瞎说。

复活路径：
- 用户再次提及 → extraction 命中已有 entity+type → `repetition_count += 1` → `last_accessed_at` 刷新 → score 重算 → 若超过 ACTIVE_UP 则升为 ACTIVE
- ARCHIVED 的记忆被再次提及时同样复活（repetition_count 累加、score 重算、state 重新评定）

### 8.2 定期维护

| 频率 | 操作 |
|---|---|
| 每次检索时 | 对返回的 ACTIVE 记忆在应用层计算 score（纯数学，不写库）。若任一条的 score 跌破 ACTIVE_DOWN，降级 state → WEAK（仅这一条触发写库） |
| 每日 cron | 对所有非 ARCHIVED 记忆计算 score → ACTIVE_DOWN 以下的降级为 WEAK，< 0.40 的降级为 ARCHIVED |
| 每周 cron | 硬删除 ARCHIVED 且 created_at > 90 天的记忆（不再需要复活） |

### 8.3 硬上限

按状态分层限制，而不是一刀切：

| 状态 | 上限 | 理由 |
|---|---|---|
| ACTIVE | **100 条** | 注入上下文的上限——再多 LLM 也消化不了 |
| WEAK | **300 条** | 观察区宽松——存储成本低，给复活留空间 |
| ARCHIVED | 不限制 | 只保留 90 天（每周 cron 硬删），不会无限增长 |

超过 ACTIVE 上限时：最低 score 的 ACTIVE 降级为 WEAK。超过 WEAK 上限时：最低 score 的 WEAK 降级为 ARCHIVED。

实际预期：认真用户 constraint(~10) + preference(~30) + habit(~20) + context_state(~10) + goal(~10) ≈ 80 条 ACTIVE，在 100 以内有裕量。

## 9. 与现有系统的集成点

### 9.1 需要改动的文件（概念）

| 改动 | 位置 | 说明 |
|---|---|---|
| 预筛选规则 | `ai/ctx.ts` 或新建 `ai/memory-extract.ts` | 提取触发判断 |
| 同步 constraint 提取 | `ai/parser.ts` parse prompt | parse 时追加轻量字段 |
| 异步提取 job + prompt | 新建 `services/memory-extract.ts` | 核心提取逻辑 |
| Scoring Engine | 新建 `services/memory-scorer.ts` | 评分公式 + 决策 |
| 混合检索 | `ai/ctx.ts` 的 `compressContext` | constraint 全量 + SQL + embedding 三层 |
| 存储表 | Prisma schema + migration | user_memory 表 + pgvector 扩展 |
| 定期维护 cron | 新建或追加现有 cron | score 刷新 + 清理 |
| Memory Center | 前端 `pages/memory.tsx` | 用户可见的记忆管理中心（见 §9.4） |

### 9.4 Memory Center（用户记忆管理中心）

评审中提出的关键产品缺失——用户不知道 AI 记住了什么，会产生不信任。必须在 v1 提供。

```
┌─────────────────────────────────┐
│  ✕      AI 了解我的         ···  │
│                                 │
│  ⟨全部 7⟩ 健康 3  习惯 2  近况 2 │
│  ───────────────────────────────│
│  ● 每天30分钟羽毛球              │
│    习惯 · 今天说的               │
│  ───────────────────────────────│
│  ○ 体重出现下降        ⟨淡忘中⟩ │
│    近况 · 今天说的               │
│  ───────────────────────────────│
│  ● 患有慢性非萎缩性胃炎          │
│    健康 · 3周前说的              │
│  ───────────────────────────────│
│         左滑任意一条可以删除     │
└─────────────────────────────────┘
   ··· 菜单：暂停记忆 / 清除所有记忆
```

功能要点：
- **一条扁平流**，按 `created_at` 倒序；不分组、不折叠——记忆总量在百条量级，分组外壳比内容还重
- **展示层三桶**：健康（constraint）／习惯（preference + habit）／近况（context_state + goal）。后端 `type` 不变，只在前端映射；筛选 chip 只出现在有内容的桶上，桶被删空自动退回"全部"
- 只显示 ACTIVE + WEAK；`WEAK` 标"淡忘中"并降低不透明度——用户能看出哪条正在失效
- 左滑删除（软删除，设 ARCHIVED），乐观更新，失败回滚；不做常驻删除按钮
- "暂停 AI 记忆" / "清除所有记忆" 收在右上 ··· 菜单里，不占正文
- 记忆来源标注（"你 3 天前说的"——从 `created_at` 推算）

> 实现注意：内容区不能套 backdrop 的 `TouchableOpacity`——外层 Touchable 抢走触摸起始责任会把列表滚动卡死。用全屏玻璃面板 + 左上关闭按钮。

### 9.2 与 LEARNING_SPEC 的交叉

提取 prompt 的排除规则覆盖 LEARNING_SPEC 的信号来源——"你估太多了应该是100g" 走学习系统，不走记忆系统。两条线各管各的，不互读对方数据。

### 9.3 与铁律 3 的关系

`user_memory` 是**事实层表**——来源是用户消息文本，与 `chat_message`（展示层）无关。删聊天不影响记忆。

## 10. 风险与护栏

| 风险 | 护栏 |
|---|---|
| 错误记忆（记了不存在的过敏） | constraint 的 ACTIVE 阈值 0.45 要求 LLM 明确提出 + type_weight × rep_boost 支撑；手动删除入口 |
| LLM 提取幻觉 | llm_confidence 是 scoring 的输入而非唯一裁决；rep_boost(n=1)=0.70 给单次提取温和折扣；乘法结构保证任一因子弱则整体低 |
| 记忆膨胀 | 100 条硬上限 + 评分驱动的自动 ARCHIVED + 90 天硬删除 |
| 上下文污染 | 注入标记明确分隔；最多 5 条；~200 token 预算 |
| entity 不一致 | 受控词表（§4.3）约束 LLM 输出；词表外新建 entity 需 scoring engine 做相似度检查；联合唯一约束兜底 |
| constraint 漏提取 | 同步路径不走预筛选，每条消息都过 constraint-only LLM 提取；零漏筛，代价是每次多 ~200 token |
| 记忆与行为矛盾（如"不吃香菜"但记录了香菜） | 当前不检测（§11 已知盲区）；不导致系统错误，但记忆可能失准 |
| 状态震荡 | 双阈值滞回（ACTIVE_UP ≠ ACTIVE_DOWN），死区 0.05-0.10 |
| 跨 session 遗忘 | 检索走 PG，不依赖 session 状态 |
| 评分公式偏差 | 参数（α, λ, 阈值）暴露为配置项，可调参不调代码；初期用保守值，上线后看数据迭代 |

## 11. 暂不纳入（后续迭代候选）

- **intervention_memory（干预记忆）**：AI 教练最核心的能力缺口。记录"什么方法对这个用户有效/无效"——早餐增加蛋白后执行率提高、晚上碳水太多导致宵夜、运动日需要额外加餐。这不再是"用户是谁"，而是"怎么带这个人瘦"。需要独立的记忆类型、评分体系和检索策略。详见下文。
- **行为推断**：从食物记录推断偏好（用户从不点辣 → 可能不吃辣）。需要 source_type=implicit_behavior，置信度远低于 explicit_user。
- **行为反馈闭环**：检测记忆与食物记录的矛盾（"不吃香菜"但记录了香菜 → 提示用户确认或自动降权）。当前记忆和 food_record 不互读。注意区分：**用户在对话里明说的否认**（"我排便正常了"）T74 已经能作废了，这里说的是**从行为数据里自己发现**矛盾，仍未做。
- **clustering / taxonomy**：entity 的层级归类（香菜→蔬菜→植物）。当前数据规模不需要。
- **记忆图谱**：实体间关系（"香菜"和"凉拌菜"的关联）。过重。
- **用户人格建模**：从偏好集合推断饮食人格（"清淡型"/"重口型"）。有趣但过早。
- **行为预测**：基于记忆预测用户可能想吃什么。远期方向。

### intervention_memory 设计方向（预览，不纳入 v1 任务拆分）

这是评审指出的最大缺口——当前设计让 AI "懂你"，但没让它"带你瘦"。

```
intervention_memory 示例：

{
  type: "strategy",
  entity: "high_protein_breakfast",
  content: "早餐增加蛋白质后用户执行率从 40% 提升到 80%",
  effect: "positive",         // positive | negative | neutral
  target_behavior: "早餐执行率",
  confidence: 0.8,
  source: "连续 14 天早餐记录对比",
}
```

核心区别：当前五种类型回答"用户是谁"，intervention 回答"**怎么帮这个人**"。它记录的是 AI 和用户之间的**互动历史**——尝试了什么、什么有效、什么翻车。这是从"懂你的 AI"升级到"带你的 AI 教练"的关键一步。

不放在 v1 的理由：需要积累至少 30 天以上的食物记录 + AI 建议历史才有足够信号。v1 先把用户画像层做扎实，数据积累够了再上干预层。
