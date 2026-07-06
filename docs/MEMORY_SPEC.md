# MEMORY_SPEC — 语义记忆系统（设计稿 v2.1）

> 本文件是语义记忆系统的**设计文档**，尚未进入任务拆分。
> v2.1 修正：rep_boost 首次折扣收窄（0.55→0.70）、去除 constraint bypass 改为参数化阈值、状态转移加滞回双阈值、放宽 UNIQUE 约束。
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

| | type=allergy | type=preference | type=context |
|---|---|---|---|
| λ (decay rate) | 0（不衰减） | 小（缓慢衰减） | 大（快速衰减） |
| 注入格式 | "🚫 务必避开" | "偏好：…" | "当前状态：…" |
| 评分阈值 | 即使低分也注入（安全优先） | 需中高分才注入 | 需高分才注入 |

### 2.3 乘法融合（任一因子归零则归零）

```
score = clamp(llm_confidence × type_weight(type) × repetition_boost(n) × decay(t), 0, 1)
```

为什么乘法而不是加权和：
- 加权和会让"没出现过的记忆"拿到 rule_score 撑起的虚假中等分
- 乘法保证：LLM 没提取到（0）、一次都没重复（接近0）、衰减到极致（接近0）→ 任一为零，score 直接归零
- 和 LEARNING_SPEC 的贝叶斯精神一致：先验精度 × 观测精度 → 后验，而非两者加权平均

## 3. 记忆类型

类型决定 λ、注入优先级、注入格式。分类保留但精简为三类——比 v1 少一类（C 和部分 B 合并），比你的 v2 更具体。

| 类型 | 含义 | 示例 | λ（衰减） | ACTIVE 阈值 | 注入格式 |
|---|---|---|---|---|---|
| **constraint** | 硬约束：安全/健康相关 | 过敏、疾病限制、宗教饮食 | 0 | ≥ **0.45**（低阈值，安全优先） | "🚫 务必避开：…" |
| **preference** | 偏好：口味/食物喜好 | 不吃香菜、爱吃辣、口淡 | 0.001 | ≥ 0.50 | "偏好：…" |
| **context** | 上下文：阶段性状态/目标 | 备赛期、出差中、本周控碳水 | 0.01 | ≥ 0.60 | "当前：…" |

λ 的含义：`decay = exp(-λ × days_since_last_access)`。λ=0 不衰减，λ=0.001 大约 3 年后衰减到 ~0.3，λ=0.01 大约 3 个月后衰减到 ~0.4。

constraint 的 ACTIVE 阈值 0.45 低于 preference 的 0.50——安全性通过参数（λ=0 + 低阈值）实现，不通过旁路规则。同一个评分引擎，同一套逻辑，不同的参数配置。

### 为什么不是 A/B/C/D 四类

- A 类（过敏/医疗/身份）→ constraint，合并理由：它们的共同点是"安全优先、不衰减、低分也注入"
- B 类（喜欢/讨厌/口味）→ preference，合并理由：都是口味偏好，衰减行为一致
- C 类（习惯/生活状态/短期目标）→ context，合并理由：都是会过期的阶段性信息
- D 类（不提取）→ 保留，放进 §4 的提取规则

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

### 4.1 双层触发：同步 constraint + 异步 preference/context

```
用户消息
  │
  ├─ [同步] parse 主链路:
  │   ├─ 规则预筛选：含 constraint 强信号词？
  │   │   ("过敏"、"不能吃"、"痛风"、"糖尿病"、"素食"、"清真"、"忌口")
  │   │   是 → LLM 追加 scope=constraint_only 提取
  │   │   提取到 → 当场写 memory → 本轮后续立即可用（零窗口期）
  │   │   否 → 跳过
  │   └─ ……正常回复用户……
  │
  └─ [异步 ~3-5s 后] 完整提取 job:
      ├─ 规则预筛选：最近 5 轮是否含任何记忆信号词？
      │   否 → 跳过，不调 LLM
      │   是 → 调 DeepSeek flash，scope=full
      ├─ 输入：最近 5 轮用户消息 + 已有最近 10 条 memory 摘要
      ├─ 输出：candidates [{type, entity, content, llm_confidence, source}]
      └─ → 送入 Scoring Engine（§5）
```

为什么 constraint 走同步：
用户说"我对花生过敏"紧接着"推荐个零食"——异步提取还没跑完，AI 可能推荐花生制品。同步提取 + 立即可用于本轮 = 零窗口期。

### 4.2 预筛选（不调 LLM，零成本）

```ts
const CONSTRAINT_TRIGGERS = [
  "过敏", "不能吃", "痛风", "糖尿病", "素食", "清真", "忌口", "过敏源"
];
const FULL_TRIGGERS = [
  ...CONSTRAINT_TRIGGERS,
  "不吃", "讨厌", "喜欢", "爱吃", "习惯", "一般", "通常", "总是",
  "最近在", "这周", "这个月", "备赛", "出差", "控碳", "戒", "少油", "少盐"
];

function shouldExtract(messages: string[]): { sync: boolean; async: boolean } {
  const recent = messages.slice(-5).join(" ");
  return {
    sync: CONSTRAINT_TRIGGERS.some(t => recent.includes(t)),
    async: FULL_TRIGGERS.some(t => recent.includes(t)),
  };
}
```

预筛选宁可松不可紧——漏筛的代价是少记一条（可接受），误筛的代价是调一次 LLM 返回空列表（浪费 ~500 token，也可接受）。

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

### context（上下文——阶段性状态/目标）
- 生活状态: "最近在备赛" → {type: "context", entity: "competition_prep", content: "备赛期"}
- 习惯: "我早上一般不吃早饭" → {type: "context", entity: "skip_breakfast", content: "通常不吃早餐"}
- 短期目标: "这周控碳水" → {type: "context", entity: "low_carb_week", content: "本周控制碳水摄入"}

## 提取规则

1. 每条 memory 必须引用原文（source 字段）。
2. llm_confidence ∈ [0,1]：你对"这是一条真实的用户特征"的把握度。
   - 0.90+：用户明确陈述，语义清晰
   - 0.80-0.90：用户明确陈述，但可能有夸张/修辞
   - 0.70-0.80：有信息量但不够明确——可能提取，交给评分系统裁决
   - <0.70：不输出
3. 主语启发式：句子主语是"我"（人）→ 可能提取；主语是"这个/那个"（食物/事情）→ 不提取。
4. 不推断、不猜测、不脑补用户没说的话。
5. entity 归一化：同义表达统一（"香菜"/"芫荽" → cilantro；"辣"/"吃辣"/"辣味" → spicy）。
6. 如果已存记忆中有同 entity+type 的 → action: "update"，否则 → action: "create"。

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
      "type": "constraint | preference | context",
      "entity": "cilantro",
      "content": "不喜欢吃香菜",
      "llm_confidence": 0.92,
      "action": "create | update",
      "source": "我不吃香菜，凉菜里别放"
    }
  ]
}
```

注意：LLM **不输出** score、不判断存不存、不决定最终状态。只负责"提取事实"。

## 5. 评分引擎（Scoring Engine）

### 5.1 评分公式

```
score = clamp(
  llm_confidence          ← LLM 的初始把握度
  × type_weight(type)     ← 类型先验（constraint 天生更可信）
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
| context | 0.85 | 阶段性状态可能随口一说 |

**repetition_boost**——重复强化：

```
repetition_boost(n) = 1 - exp(-1.2 × n)

n=1 → 0.70   (第一次说，温和折扣)
n=2 → 0.91   (第二次说，接近满)
n=3 → 0.97   (第三次说，基本确信)
n=4+→ →1.0   (饱和)
```

α=1.2 使得单次提及保留 70% 权重——用户明确说了一次"不吃香菜"，不至于被系统性压到 WEAK 底部。二次确认后迅速收敛到 0.91，三次后基本等同于确信。折扣曲线陡峭意味着"从0到1"这一步是最大的跃迁，后续递减极快——这与实际的信号可靠性一致：第一次提及的信息量最大，第二次是验证，第三次以上是冗余。

**decay**——时间衰减：

```
decay(t) = exp(-λ(type) × Δt)

λ(constraint) = 0        → 不衰减（过敏不会自愈）
λ(preference) = 0.001    → 1 年后 ~0.70，3 年后 ~0.33
λ(context)   = 0.01      → 3 个月后 ~0.41，6 个月后 ~0.17
```

Δt = 当前时间 - `last_accessed_at`（上次被注入或更新的时间，不是 created_at）。每次用户再次提及或系统检索注入，last_accessed_at 刷新，decay 拉回 1.0。

### 5.3 决策规则

不同类型有各自的 ACTIVE 阈值（见 §3 表）。统一规则：

```
score ≥ ACTIVE_THRESHOLD[type]  → state = ACTIVE   → 检索时注入上下文
0.40 ≤ score < ACTIVE_THRESHOLD  → state = WEAK    → 保留但不注入（观察中，等更多证据）
score < 0.40                     → state = ARCHIVED → 不注入，不参与检索
```

constraint 的 ACTIVE 阈值 0.45 低于 preference 的 0.50——安全性通过参数实现，不通过旁路。同一套评分引擎、同一套决策逻辑，不同类型的参数配置不同。这消除了 v2 的"双引擎"问题。

ARCHIVED 的 0.40 底线对所有类型相同——低于此线意味着 LLM 本身就不太确定（llm_confidence < 0.70）且没有被重复强化过，无论什么类型都不该注入。

### 5.4 示例演算

**场景 1：用户第一次说"我对花生过敏"**

```
llm_confidence = 0.95
type_weight(constraint) = 1.0
repetition_boost(1) = 0.70
decay(0) = 1.0

score = 0.95 × 1.0 × 0.70 × 1.0 = 0.67
→ constraint ACTIVE 阈值 = 0.45 → ACTIVE ✓（首次强信号即生效）
```

**场景 2：用户第一次说"我超爱吃辣"**

```
llm_confidence = 0.85
type_weight(preference) = 0.90
repetition_boost(1) = 0.70
decay(0) = 1.0

score = 0.85 × 0.90 × 0.70 × 1.0 = 0.54
→ preference ACTIVE 阈值 = 0.50 → ACTIVE ✓（明确偏好首次即过线）
```

**场景 3：用户第三次说"不吃香菜"，跨度 2 个月**

```
llm_confidence = 0.90
type_weight(preference) = 0.90
repetition_boost(3) = 0.97
decay(60天) = exp(-0.001 × 60) = 0.94

score = 0.90 × 0.90 × 0.97 × 0.94 = 0.74
→ preference ACTIVE 阈值 = 0.50 → ACTIVE ✓（稳固）
```

**场景 4：用户半年前说"最近在备赛"，之后再没提过**

```
llm_confidence = 0.80
type_weight(context) = 0.85
repetition_boost(1) = 0.70
decay(180天) = exp(-0.01 × 180) = 0.17

score = 0.80 × 0.85 × 0.70 × 0.17 = 0.081
→ context ACTIVE 阈值 = 0.60 → 远低于 → ARCHIVED（自动沉底）
```

### 5.5 冲突处理

当提取到的 entity+type 命中已有记忆但内容方向相反时：

```
if 新记忆与旧记忆 entity+type 相同但 content 语义相反:
    if llm_confidence_new > llm_confidence_old + 0.10:
        replace（新证据更强，覆盖旧记忆）
    else:
        旧记忆 score 减半（降权但不删除）
        新记忆正常入库，score 按公式正常计算
        两条共存，由检索时的 score 自然裁决
```

不引入 `contradicted` 状态——冲突通过 score 的数学机制自然解决：旧记忆降权后可能落入 WEAK 或 ARCHIVED，新记忆如果持续被强化则升为 ACTIVE。如果两条都掉到 ARCHIVED，说明用户自己也不一致，系统不做强行裁断。

## 6. 存储模型

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE user_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  type VARCHAR NOT NULL CHECK (type IN ('constraint', 'preference', 'context')),
  entity VARCHAR NOT NULL,          -- 归一化实体：cilantro, spicy, peanut
  content TEXT NOT NULL,            -- 人类可读文本，供 LLM 上下文注入

  llm_confidence REAL NOT NULL,     -- LLM 初始把握度（提取时记录，不变）
  repetition_count INTEGER NOT NULL DEFAULT 1,  -- 累计被提及次数
  score REAL NOT NULL,              -- 当前综合评分（每次 scoring 重算）
  state VARCHAR NOT NULL DEFAULT 'WEAK',  -- ACTIVE | WEAK | ARCHIVED

  embedding vector(1024),           -- pgvector，content 的向量表示

  source_message_id UUID,           -- 追溯
  source_text TEXT,                 -- 追溯：原文片段

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, type, entity, content)
  -- 同用户、同类型、同实体、但内容实质性不同（如"不吃香菜" vs "在尝试接受香菜"）可以共存
  -- 去重逻辑由应用层的 scoring engine 在写入前处理：同 (user_id, type, entity) 且语义相近 → update；语义相反 → 冲突处理（§5.5）
);

CREATE INDEX idx_user_memory_state ON user_memory(user_id, state);
CREATE INDEX idx_user_memory_score ON user_memory(user_id, score DESC);
CREATE INDEX idx_user_memory_embedding ON user_memory
  USING hnsw (embedding vector_cosine_ops);
  -- HNSW 适合小数据量高并发场景；若用户量少也可用 ivfflat
```

与 v1 的关键差异：
- 去掉了 `key` 字段，改用 `(user_id, type, entity, content)` 联合唯一约束——允许同 entity 不同内容共存（如"不吃香菜"preference + "尝试接受香菜"context），应用层去重
- 去掉了 `ttl_days`，衰减由 scoring engine 的 decay 函数统一管理
- 去掉了 `structured` jsonb（预留过度，v1 先不加）
- `status` 改为 `state`，值从 active/stale/contradicted/deleted → ACTIVE/WEAK/ARCHIVED，带双阈值滞回
- 新增 `repetition_count`（scoring 的一级输入）
- 新增 `score`（每次 scoring 重算落库）

## 7. 检索与注入

### 7.1 检索流程

```
用户最新消息
  │
  ├─ 生成 embedding(content: 当前消息文本)
  ├─ pgvector 检索：
  │   SELECT * FROM user_memory
  │   WHERE user_id = $1 AND state = 'ACTIVE'
  │   ORDER BY embedding <=> $2
  │   LIMIT 5
  │
  └─ 注入 L2 上下文 → compressContext
```

检索取 state=ACTIVE + 按 embedding 相似度排序 top-5。constraint 类型通过低 ACTIVE 阈值（0.45）自然进入 ACTIVE 池，无需额外查询——同一套检索逻辑覆盖所有类型。

### 7.2 注入格式

在 `compressContext` 的【用户档案】下方插入：

```
【关于你】
  🚫 务必避开：花生过敏（食用后过敏）
  偏好：喜欢辣味，不喜欢香菜
  当前：备赛期（3 个月前更新，可能已变化）

【用户档案】…（现有 L2）
【今日进度】…（现有 L2）
...
```

注入规则：
- constraint 加 `🚫 务必避开` 前缀
- preference 加 `偏好：`
- context 加 `当前：`，且如果 `last_accessed_at > 60 天前`，追加 `（N 个月前更新，可能已变化）`
- 最多 5 条，总 token 预算 ~200
- 按 score 降序排列

### 7.3 检索时机

每次构建 ContextPack（`buildMemoryPack`）时执行。PG 本地查询 + HNSW 索引，数据量几十条，延迟 ~2-5ms，可内联无需缓存。

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
| context | 0.65 | 0.55 | 0.10 |

晋升阈值比降级阈值高 0.05-0.10，形成死区。score 在死区内波动时状态不变，防止 WEAK↔ACTIVE 反复震荡。约束类型的死区更窄（0.08），因为其 decay=0 不存在自然衰减导致的波动，更宽的缓冲区无意义。

复活路径：
- 用户再次提及 → extraction 命中已有 entity+type → `repetition_count += 1` → `last_accessed_at` 刷新 → score 重算 → 若超过 ACTIVE_UP 则升为 ACTIVE
- ARCHIVED 的记忆被再次提及时同样复活（repetition_count 累加、score 重算、state 重新评定）

### 8.2 定期维护

| 频率 | 操作 |
|---|---|
| 每次检索时 | 对该用户所有非 ARCHIVED 记忆重算 score（顺便刷新 state） |
| 每日 cron | 对 30 天未访问的 WEAK 记忆重算 score → 部分落入 ARCHIVED |
| 每周 cron | 硬删除 ARCHIVED 且 created_at > 90 天的记忆（不再需要复活） |

### 8.3 硬上限

每用户最多 **100 条**非 ARCHIVED 记忆。超过时，最低 score 的 ARCHIVED 先被硬删，然后最低 score 的 WEAK 被 ARCHIVED。防止失控增长。

## 9. 与现有系统的集成点

### 9.1 需要改动的文件（概念）

| 改动 | 位置 | 说明 |
|---|---|---|
| 预筛选规则 | `ai/ctx.ts` 或新建 `ai/memory-extract.ts` | 提取触发判断 |
| 同步 constraint 提取 | `ai/parser.ts` parse prompt | parse 时追加轻量字段 |
| 异步提取 job + prompt | 新建 `services/memory-extract.ts` | 核心提取逻辑 |
| Scoring Engine | 新建 `services/memory-scorer.ts` | 评分公式 + 决策 |
| 检索注入 | `ai/ctx.ts` 的 `compressContext` | L2 上下文注入点 |
| 存储表 | Prisma schema + migration | user_memory 表 + pgvector 扩展 |
| 定期维护 cron | 新建或追加现有 cron | score 刷新 + 清理 |
| 设置页 | 前端 settings | "AI 记忆管理"（可选，可后置） |

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
| entity 不一致 | LLM 在提取时归一（prompt 明确要求）；联合唯一约束兜底 |
| 状态震荡 | 双阈值滞回（ACTIVE_UP ≠ ACTIVE_DOWN），死区 0.05-0.10 |
| 跨 session 遗忘 | 检索走 PG，不依赖 session 状态 |
| 评分公式偏差 | 参数（α, λ, 阈值）暴露为配置项，可调参不调代码；初期用保守值，上线后看数据迭代 |

## 11. 暂不纳入（v2+ 候选）

- **行为推断**：从食物记录推断偏好（用户从不点辣 → 可能不吃辣）。先只做显式声明。
- **clustering / taxonomy**：entity 的层级归类（香菜→蔬菜→植物）。当前数据规模不需要，用 type+entity 足够。
- **记忆图谱**：实体间关系（"香菜"和"凉拌菜"的关联）。过重。
- **用户人格建模**：从偏好集合推断饮食人格（"清淡型"/"重口型"）。有趣但过早。
- **行为预测**：基于记忆预测用户可能想吃什么。v3 的事。
