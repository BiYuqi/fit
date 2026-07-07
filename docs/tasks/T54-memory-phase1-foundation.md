# T54 — 语义记忆 Phase 1：地基（DB + 纯函数）

**状态**：⬜待办

**目标**：创建 `user_memory` 表、Scoring Engine 纯函数、Memory Store CRUD，全部零侵入——不碰任何现有代码。

**依赖**：无强依赖。需 pgvector 扩展可用（本地 PG 容器已有）。
**关注文档**：`docs/MEMORY_SPEC.md` §3（五类型定义）、§5（评分引擎）、§6（存储模型）、§8（生命周期）

## 背景

MEMORY_SPEC 经过三轮评审已定稿。这是语义记忆系统的第一阶段——只建地基，不接线。Phase 2 才把提取和注入接入 chat 流程。

## 做什么

### 1.1 pgvector 扩展 + UserMemory 表

- Prisma migration：CREATE EXTENSION vector + UserMemory 表
- schema 字段与 MEMORY_SPEC §6 一致
- 索引：`idx_user_memory_state`、`idx_user_memory_last_access`、HNSW embedding 索引
- CHECK 约束五类型：constraint / preference / habit / context_state / goal

### 1.2 Scoring Engine（`services/memory-scorer.ts`）

纯函数，零副作用，可直接单测：

```
computeScore(params) → number
  - llm_confidence, type_weight, importance_class, repetition_boost, decay

importanceMap(class) → number
  - medical→1.3, strong→1.1, normal→1.0, casual→0.85

repetitionBoost(n) → number
  - 1 - exp(-1.2 × n)

decay(type, lastAccessedAt) → number
  - exp(-λ(type) × daysSinceLastAccess)

decideState(type, score) → 'ACTIVE' | 'WEAK' | 'ARCHIVED'
  - 双阈值滞回：ACTIVE_UP / ACTIVE_DOWN，参见 MEMORY_SPEC §8.1 表
```

### 1.3 Memory Store（`services/memory-store.ts`）

- `loadActiveMemories(userId)` → 混合检索查询（MEMORY_SPEC §7.1）：
  - constraint 全量拉取
  - context_state + goal 按 score 降序 top-3
  - 返回结构化结果供 Phase 2 注入
- `upsertMemory(userId, candidate)` → INSERT ON CONFLICT 或 UPDATE
- `updateAccessTime(memoryId)` → 刷新 last_accessed_at
- `archiveMemory(memoryId)` → 软删除（设 ARCHIVED）
- `deleteExpiredMemories(userId)` → 硬删 ARCHIVED + created_at > 90 天
- `generateEmbedding(content)` → 调 DeepSeek embedding API（1024 维）

### 1.4 单测

从 MEMORY_SPEC §5.4 直接搬 8 个场景：

1. 花生过敏首次（constraint + medical → score 0.86 → ACTIVE）
2. 爱吃辣首次（preference + normal → score 0.54 → ACTIVE）
3. 不吃香菜第三次 + 2 月（preference + normal + decay → score 0.74 → ACTIVE）
4. 出差状态首次（context_state + normal → score 0.52 → ACTIVE）
5. 不吃早饭首次 + 2 月未提（habit + normal + decay → score 0.449 → WEAK）
6. 备赛半年前（goal + normal + decay → score 0.012 → ARCHIVED）
7. 控碳水 2 周过期（goal + normal + expires_at → score 0.068 → ARCHIVED）
8. 胃不舒服首次（preference + strong → score 0.589 → ACTIVE）

## 验收

- [ ] migration 可执行，表创建成功，索引生效
- [ ] `computeScore` 8 个场景数值与 spec 一致（容差 ±0.01）
- [ ] `decideState` 跨阈值行为正确（晋升/降级/死区不震荡）
- [ ] `importanceMap` 四类映射正确
- [ ] `repetitionBoost` n=1→0.70, n=2→0.91, n=3→0.97
- [ ] `loadActiveMemories` 混合检索：constraint 全量、context_state/goal 按 score、结果数合理
- [ ] `upsertMemory` INSERT + ON CONFLICT UPDATE 两条路径都可工作
- [ ] 单测全绿，tsc 零错误

## 落地记录

（待填）
