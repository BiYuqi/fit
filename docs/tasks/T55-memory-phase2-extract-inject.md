# T55 — 语义记忆 Phase 2：提取 + 注入（接入 chat 流程）

**状态**：⬜待办

**目标**：LLM 提取管线（同步 constraint + 异步 full）接入 chat 流程，记忆注入 compressContext。这是 MEMORY_SPEC 首次触达现有代码。

**依赖**：T54（user_memory 表 + scorer + store 已就绪）
**关注文档**：`docs/MEMORY_SPEC.md` §4（提取管线）、§7（检索与注入）

## 背景

Phase 1 地基已铺好。Phase 2 把提取和注入接上线——用户消息进入 chat.ts 后，constraint 关键词命中则同步提取并立即写入，响应返回后异步跑 full 提取。同时 compressContext 新增 `【关于你】` 段落。

## 侵入面

| 文件 | 改动 | 侵入量 |
|---|---|---|
| `services/memory-extract.ts` | **新建**：提取 prompt + 调 LLM + 送 scoring engine | ~200 行 |
| `services/memory.ts` | `buildMemoryPack` 末尾加 `loadActiveMemories` | +5 行 |
| `ai/ctx.ts` | `compressContext` 加 `【关于你】` 段落 | +15 行 |
| `routes/chat.ts` | parse 前插 constraint 扫描 + 同步提取 | +15 行 |

**不动**：parser.ts、schema.ts、matcher.ts、learning.ts、所有 intent handler。

## 做什么

### 2.1 Memory Extractor（`services/memory-extract.ts`）

**constraintOnlyExtract(text, userId)**：
- 关键词预筛选（~50 词，MEMORY_SPEC §4.2 CONSTRAINT_KEYWORDS）
- 命中 → 调 DeepSeek flash，scope=constraint_only prompt（~80 token）
- 提取到 candidate → 送 Scoring Engine → `upsertMemory`
- 返回写入的 memory 列表（供 chat.ts 当场可用）

**fullExtract(userId)**（异步）：
- 取最近 5 轮用户消息 + 已有最近 10 条 memory 摘要
- 异步预筛选（FULL_TRIGGERS）→ 命中则调 flash
- LLM 输出 candidates → 逐个送 Scoring Engine → upsert
- 失败静默，不影响主流程

**提取 prompt**：严格按 MEMORY_SPEC §4.3，包含五类型定义、受控 entity 词表、排除规则、importance_class。

### 2.2 Context 注入（改动 `services/memory.ts` + `ai/ctx.ts`）

`buildMemoryPack` 加一步：
```ts
const activeMemories = await loadActiveMemories(userId);
// 混合检索：constraint 全量 + context_state/goal 按 score + preference/habit embedding top-5
pack.active_memories = activeMemories;
```

`compressContext` 在 `【用户档案】` 上方插入 `【关于你】`：
```
【关于你】
  🚫 务必避开：花生过敏
  偏好：喜欢辣味，不喜欢香菜
  习惯：通常不吃早餐
  当前状态：出差中（2 周前更新）
  目标：备赛期（可能已过期）

【用户档案】…
```

注入规则按 MEMORY_SPEC §7.2：constraint 永远排最前 + 全量注入，其他按 score 降序，总条数 constraint 全量 + 最多 8 条其他。

### 2.3 chat.ts 接入点

```
现有流程：
  writeUserBubble → buildMemoryPack → parseUserInput → route → reply

Phase 2 后：
  writeUserBubble
  → constraintKeywordScan(text)          ← 新增，< 0.1ms
  → 命中? constraintOnlyExtract(text)    ← 新增，~300ms（仅命中时）
    → 写入 user_memory（立即可用）
  → buildMemoryPack                      ← 现在包含刚写入的 constraint + 历史 memories
  → parseUserInput → route → reply
  → (响应返回后) setImmediate fullExtract ← 新增，异步不阻塞
```

### 2.4 端到端用例

场景：用户说"我对花生过敏，推荐个零食"
1. 关键词扫描命中"过敏"
2. 同步提取出 `{type: constraint, entity: peanut, content: "花生过敏", importance_class: medical}`
3. Scoring Engine：score=0.86 → ACTIVE，立即写入 user_memory
4. buildMemoryPack 读到这条刚写入的 constraint
5. compressContext 注入：`🚫 务必避开：花生过敏`
6. AI 回复不会推荐花生制品
7. 响应返回后，异步 fullExtract 跑完（提取到可能的口味偏好等）

## 验收

- [ ] 关键词"过敏"命中 → 同步提取触发，constraint 写入 user_memory
- [ ] 关键词"你好"不命中 → 同步提取跳过，零额外 LLM 调用
- [ ] 同步提取的 constraint 在**同一轮** compressContext 中出现（零窗口期）
- [ ] `【关于你】` 段落注入 compressContext，constraint 前缀 `🚫 务必避开`
- [ ] 异步 fullExtract 在响应返回后执行，不阻塞 chat 响应
- [ ] 异步提取失败不影响主流程（静默 catch）
- [ ] 已有 memory 被正确去重——同 entity+type 的走 update 而非 create
- [ ] 全量 eval 零回归（constraint 注入不应破坏现有解析行为）
- [ ] tsc 零错误

## 落地记录

（待填）
