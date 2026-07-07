# T56 — 语义记忆 Phase 3：生命周期 + Memory Center

**状态**：⬜待办

**目标**：记忆定期维护（score 刷新/降级/清理）、Memory Center API、前端管理页面。闭环语义记忆系统的最后一块。

**依赖**：T55（提取 + 注入已上线，user_memory 表有数据流入）
**关注文档**：`docs/MEMORY_SPEC.md` §8（生命周期管理）、§9.4（Memory Center UI）

## 背景

Phase 2 让记忆开始流入和注入。Phase 3 确保记忆不会腐烂——定期降级过期记忆、清理垃圾、给用户可见的管理入口。

## 侵入面

| 文件 | 改动 | 侵入量 |
|---|---|---|
| `services/memory-store.ts` | 加 `recalcAndPrune()`、`getUserMemories()`、`deleteMemory()`、`pauseMemory()` | +60 行 |
| `routes/memory.ts` | **新建**：Memory Center API | ~50 行 |
| `index.ts` | 注册新路由 + 启动 cron | +5 行 |
| `frontend/src/components/MemoryCenterModal.tsx` | **新建**：全屏 modal（按类型分组列表 + 删除/暂停/清除） | ~250 行 |
| `frontend/src/app/settings.tsx` | Settings 页加一个 row 入口 | +8 行 |

## 做什么

### 3.1 Cron 维护（`services/memory-store.ts`）

两个 cron job，用 node-cron 注册在 `index.ts`：

**每日 cron（凌晨 3:00）**：
- 对所有非 ARCHIVED 记忆计算当前 score
- ACTIVE_DOWN 以下的降级为 WEAK
- < 0.40 的降级为 ARCHIVED

**每周 cron（周日 4:00）**：
- 硬删除 ARCHIVED 且 created_at > 90 天的记忆
- 检查硬上限：ACTIVE > 100 → 最低 score 降级为 WEAK；WEAK > 300 → 最低 score 降级为 ARCHIVED

### 3.2 Memory Center API（`routes/memory.ts`）

```
GET    /api/memory          → 返回用户所有非 ARCHIVED 记忆，按类型分组
PATCH  /api/memory/:id      → 更新单条记忆（手动修改 content）
DELETE /api/memory/:id      → 软删除单条记忆（设 ARCHIVED）
POST   /api/memory/pause    → 暂停/恢复 AI 记忆提取（toggle）
DELETE /api/memory/clear    → 全部软删除
```

### 3.3 导航入口

**位置**：Settings 页，在"身体数据"和"目标"两个 section 之间插入一个新 row。不加新 Tab——现有 4 Tab 刚好，记忆管理和身体数据、目标是同类的"我"的信息。

```
Settings 页 ScrollView:

  ┌─ 身体数据 ─────────────────┐
  │ 身高 / 体重 / 年龄 / …     │
  └────────────────────────────┘

  ┌─ AI 了解我的 ──────────────┐  ← 新增 GlassSectionCard
  │ 5 条活跃记忆           >   │  ← SettingsRow，点开全屏 modal
  └────────────────────────────┘

  ┌─ 目标 ─────────────────────┐
  │ 目标体重 / …                │
  └────────────────────────────┘
```

**SettingsRow 副标题**根据记忆数量动态变化：

| 记忆数 | 副标题 |
|---|---|
| 0 | "暂无记忆" |
| 1-99 | "N 条活跃记忆" |
| 暂停中 | "已暂停"（橙色） |

**点击** → 打开 `MemoryModal`。组件挂载在 SettingsScreen 内，由 `visible` state 控制，与 ChatScreen 挂载 SearchModal 的模式完全相同。

### 3.4 Memory Modal（`components/chat/memory-modal.tsx`）

**复刻 SearchModal 的全屏玻璃 modal 模式**，不是 Settings 页 PickerModal/StepperModal 那种居中卡片。

```
┌─────────────────────────────────────────────┐
│ Modal (animationType="fade", transparent)    │
│  ┌───────────────────────────────────────┐   │
│  │ TouchableOpacity (backdrop, 点此关闭)  │   │
│  │  ┌─────────────────────────────────┐  │   │
│  │  │ BlurView (intensity=52)          │  │   │
│  │  │  LinearGradient (glass overlay)   │  │   │
│  │  │                                  │  │   │
│  │  │  ┌──────────────────────────┐   │  │   │
│  │  │  │ 取消  AI 了解我的        │   │  │   │  ← 三栏顶栏
│  │  │  └──────────────────────────┘   │  │   │
│  │  │                                  │  │   │
│  │  │  ScrollView                      │  │   │
│  │  │  ┌──────────────────────────┐   │  │   │
│  │  │  │ 🚫 饮食禁忌  (2)         │   │  │   │  ← 分组标题（非卡片，纯文字）
│  │  │  │ ┌──────────────────────┐ │   │  │   │
│  │  │  │ │ 🥜 花生过敏          │ │   │  │   │  ← 每行：emoji + content
│  │  │  │ │    7月4日说的     [✕]│ │   │  │   │      副标题：来源日期
│  │  │  │ │ 🥛 乳糖不耐          │ │   │  │   │      右端：删除按钮
│  │  │  │ │    7月1日说的     [✕]│ │   │  │   │
│  │  │  │ └──────────────────────┘ │   │  │   │
│  │  │  │                          │   │  │   │
│  │  │  │ 🌶 饮食偏好  (3)         │   │  │   │
│  │  │  │ ┌──────────────────────┐ │   │  │   │
│  │  │  │ │ 🌶 喜欢辣味          │ │   │  │   │
│  │  │  │ │ …                    │ │   │  │   │
│  │  │  │ └──────────────────────┘ │   │  │   │
│  │  │  │                          │   │  │   │
│  │  │  │ ☕ 生活习惯  (1)         │   │  │   │  ← 没有的分组不渲染
│  │  │  │ 📍 当前状态  (1)         │   │  │   │
│  │  │  │ 🎯 目标  (1)             │   │  │   │
│  │  │  └──────────────────────────┘   │  │   │
│  │  │                                  │  │   │
│  │  │  ┌──────────────────────────┐   │  │   │
│  │  │  │ 暂停 AI 记忆         [○]│   │  │   │  ← Toggle（玻璃行）
│  │  │  └──────────────────────────┘   │  │   │
│  │  │                                  │  │   │
│  │  │  [清除所有记忆]                 │  │   │  ← 红色文字，居中
│  │  │                                  │  │   │
│  │  │  <card border 0.5px>            │  │   │
│  │  └─────────────────────────────────┘  │   │
│  └───────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### 3.5 与 SearchModal 的对齐点

| 特性 | SearchModal | MemoryModal |
|---|---|---|
| 组件 | `<Modal animationType="fade" transparent>` | 同 |
| 玻璃背景 | `BlurView intensity={52}` + `LinearGradient` 3 stops | 同，直接用相同 color tokens |
| 顶栏 | 三栏：取消 / 标题 / spacer | 同：取消 / "AI 了解我的" / spacer |
| 顶栏 padding | `paddingTop: insets.top + 12` | 同 |
| 关闭方式 | 取消按钮 / 点 backdrop / Android back | 同 |
| 打开时重置 | `visible→true` 时清空 state → fetch | 同：`visible→true` 时 `GET /api/memory` |
| 卡片边框 | 0.5px border | 同 |
| Footer | 无 | 无（暂停 + 清除是 ScrollView 内元素，不是独立 footer） |

**差异**：MemoryModal 没有搜索输入框，没有 FlatList（用 ScrollView），没有日期选择器。

### 3.6 交互细节

| 操作 | 行为 |
|---|---|
| 打开 modal | `visible→true` → `useEffect` 触发 `GET /api/memory` → 按 type 分组 → `setGroups(data)`。loading 时不阻塞 UI，modal 直接出（玻璃背景先渲染，内容区用 ActivityIndicator） |
| 点 [✕] 删除 | Alert 确认："删除这条记忆？" → 确定 → `DELETE /api/memory/:id` → 该行从本地 state 移除 + iOS `impactOccurred` haptic |
| 暂停 AI 记忆 | Toggle ON → `POST /api/memory/pause { paused: true }` → chat.ts 的 constraint 扫描 + 异步 fullExtract 都跳过。Settings row 副标题变橙色"已暂停"。Toggle OFF → 恢复 |
| 清除所有记忆 | 红色文字按钮 → 破坏性 Alert："清除后 AI 将忘记所有关于你的信息，确定？"（红色按钮）→ `DELETE /api/memory/clear` → `setGroups([])` 回到空状态 |
| 空状态 | 居中：SF Symbol `brain.head.profile` + "AI 还不了解你"（16px semibold）+ "多在聊天里告诉它你的喜好、习惯和禁忌吧"（14px 灰色）。点取消或 backdrop 关闭 |
| 关闭 | 点"取消"、点 backdrop（玻璃外的半透明区域）、Android 硬件回退 → `onClose()` → `setVisible(false)` |

### 3.7 各组配置

| type | 分组标题 | emoji |
|---|---|---|
| constraint | 饮食禁忌 | 🚫 |
| preference | 饮食偏好 | 🌶 |
| habit | 生活习惯 | ☕ |
| context_state | 当前状态 | 📍 |
| goal | 目标 | 🎯 |

分组按固定顺序排列（constraint 永远第一，其余按组内最高 score 的组间排序）。每组计数只算 ACTIVE + WEAK。空分组不渲染。每条记忆行显示：emoji 前缀 + `content` + 来源日期（`source_message_id` → 查 `chat_message.created_at` → "N天前说的"）+ 右端 [✕] 删除按钮。

### 3.8 组件树与文件位置

```
frontend/src/components/chat/memory-modal.tsx  ← 新建

SettingsScreen (frontend/src/app/settings.tsx)
  ├─ ScrollView
  │    ├─ GlassSectionCard (身体数据)
  │    ├─ GlassSectionCard (AI 了解我的)     ← 新增
  │    │    └─ SettingsRow(
  │    │         label="AI 了解我的",
  │    │         value=memoryCount > 0
  │    │           ? `${count} 条活跃记忆`
  │    │           : isPaused ? "已暂停" : "暂无记忆",
  │    │         onPress={() => setMemoryModalVisible(true)}
  │    │       )
  │    └─ GlassSectionCard (目标)
  └─ MemoryModal                                    ← 新增，挂载在 SettingsScreen 底部
       visible={memoryModalVisible}
       onClose={() => setMemoryModalVisible(false)}

MemoryModal 内部组件树:
  Modal (animationType="fade", transparent)
    └─ TouchableOpacity (backdrop, onPress=onClose)
         └─ BlurView (intensity=52)
              └─ LinearGradient (glass overlay, 3 stops)
                   ├─ TopBar: 取消 | "AI 了解我的" | spacer
                   ├─ ScrollView
                   │    ├─ MemoryGroup × 5 (条件渲染，空分组跳过)
                   │    │    ├─ SectionHeader: emoji + 标题 + (计数)
                   │    │    └─ MemoryRow × N
                   │    │         ├─ emoji + content
                   │    │         ├─ "N天前说的" 副标题
                   │    │         └─ TouchableOpacity [✕]
                   │    ├─ PauseToggleRow (玻璃行)
                   │    └─ ClearAllButton (红色文字)
                   ├─ EmptyState (条件渲染，totalCount === 0)
                   └─ CardBorder (0.5px)
```

**SettingsScreen 需要的改动**：
- 加一个 `useState<boolean>(false)` 控制 modal visible
- 加一个 `useQuery(['memory-count'])` 获取记忆数量（渲染副标题用），或从 MemoryModal 关闭时回调
- 在 JSX 底部挂载 `<MemoryModal>`

## 验收

- [ ] 每日 cron 正确降级：30 天未访问的 context_state → WEAK，score < 0.40 → ARCHIVED
- [ ] 每周 cron 正确清理：ARCHIVED + 90 天 → 硬删除
- [ ] 硬上限生效：ACTIVE 超过 100 条时最低 score 降级
- [ ] Memory Center API：GET 返回分组数据、DELETE 软删除、POST pause 切换提取开关
- [ ] Settings 页"AI 了解我的"row 出现，位于身体数据和目标之间；副标题随记忆数动态变化（"暂无记忆"/"N 条活跃记忆"/"已暂停"）
- [ ] 点击 row → fade 动画打开全屏玻璃 modal（BlurView + LinearGradient，同 SearchModal 视觉）
- [ ] 顶栏三栏：取消 | "AI 了解我的" | spacer，点取消或点 backdrop 关闭
- [ ] 按类型分组渲染，空分组不显示，constraint 永远排第一
- [ ] 每条记忆显示：emoji + content + "N 天前说的" + 右端 [✕] 删除按钮
- [ ] 点 [✕] → Alert 确认 → 删除 + haptic feedback；暂停 toggle 双向切换 + Settings row 副标题联动
- [ ] 清除所有记忆：破坏性 Alert 确认 → 全部软删除 → 空状态
- [ ] 0 条记忆时显示空状态（brain.head.profile 图标 + 引导文案），点取消可关闭
- [ ] 全量 eval 零回归
- [ ] 前后端 tsc 零错误

## 落地记录

（待填）
