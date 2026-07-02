# T26 — 聊天搜索功能 + 数据本地化重构

**状态**：✅完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：去掉聊天页顶部日期 pill，数据本地化（SQLite 全量 → FlatList 连续渲染），右上角加搜索按钮，弹窗支持文案搜索跳转 + 按日期跳转。
**依赖**：T11 T12 T16　**关注文档**：API_SPEC 聊天，DESIGN_SPEC §3

> 详细方案见 `.claude/plans/wondrous-watching-sprout.md`。本任务文件是该方案的执行拆分。

## 硬边界（务必遵守）

1. **不碰核心聊天交互**：`POST /api/chat/message`、`POST /api/pending/:id/resolve`、`POST /api/records/:id/undo` 一行不改。
2. **不修改现有 `GET /api/chat/messages?date=`**：新增独立端点，旧端点原封不动。
3. **不写冗余抽象**：不引入 service 层、Repository、Base 类。Prisma 查询 + Zod 校验 + `apiFetch` 封装，`db.ts` 纯 SQL 函数，`chat-store.ts` Zustand，不加中间层。
4. **不碰卡片组件**：`message-item.tsx`、`record-card.tsx`、`portion-card.tsx` 等 8 个零改动。
5. **不碰 AppTabs / 路由 / 其他页面**。
6. **不改变 chat_message 的定位**：仍是展示层。

## 做什么

### Step 1: 后端 — 新增全量读取端点
- 文件：`backend/src/routes/chat.ts`
- 在文件末尾（`app.get("/api/chat/dates", ...)` 之后）新增 `GET /api/chat/messages/range?from=YYYY-MM-DD&to=YYYY-MM-DD`
- 查询：`prisma.chatMessage.findMany({ where: { user_id, date: { gte: from, lte: to } }, orderBy: { created_at: "asc" } })`
- 复用现有 `toDateOnly()`（第 57 行）、`auth` preHandler、Zod schema 模式
- 包含 `resolved_pending_ids` 收集逻辑（和现有单日查询一致，接受 15 行重复）
- 返回：`{ messages: ChatMessage[], resolved_pending_ids: string[] }`

### Step 2: 搬迁 `formatDateLabel` 到 `lib/format.ts`
- 文件：`frontend/src/lib/format.ts`
- 从 `date-selector.tsx`（稍后删除）搬迁 `parseDateStr` 和 `formatDateLabel`
- `parseDateStr`：`new Date(y, m-1, d, 12, 0, 0)` 确保本地中午，不用 ISO 字符串（时区不一致）
- `formatDateLabel`：返回「今天」「昨天」「M月D日 周X」

### Step 3: `db.ts` 新增 `getAllMessages`
- 文件：`frontend/src/lib/db.ts`（加在 `clearCache` 之后）
- 5 行函数：`SELECT * FROM chat_messages ORDER BY date ASC, created_at ASC`
- 同时提取模块级私有 `parseRow` 函数（当前逻辑内联在 `getCachedMessages` 中）

### Step 4: chat-store 重构
- 文件：`frontend/src/stores/chat-store.ts`
- **新增**：`loadAllMessages(token)` — 两阶段加载：读本地 SQLite 全量（秒渲染）→ 调 `GET /api/chat/messages/range` → 按日期分组调 `upsertMessages` 写入 → 替换 `messages`
- **删除**：`selectedDate`、`loadForDate`、`setDate` 状态/方法
- **微调**：`send` 和 `resolve` 中 `get().selectedDate` 改为 `newMsgs[0]?.date ?? todayStr()`（传给 `upsertMessages` 的日期参数）
- `resolve` / `undo` 逻辑不变（splice 消息、标记状态在全量数组上同样工作）
- 注意：`getCachedMessages` import 随 `loadForDate` 删除后移除（dead import）

### Step 5: ChatScreen UI 重构
- 文件：`frontend/src/app/index.tsx`
- **删 DateSelector**：移除 import、JSX、`datePillWrapper` 样式
- **删 `localDateStr` import**：仅剩的两处使用（stale-date useEffect）一并删除后不再需要
- **删 date-change 滚动逻辑**：`lastScrolledDateRef`、date-change useEffect（`[selectedDate, visibleMessages.length]`）
- **删 `handleSelectDate` callback**
- **加搜索按钮**：右上角，完整 5 层毛玻璃结构（shadow → blur → gradient → highlight → border → icon），和 `app-tabs.tsx` back 按钮视觉一致。直接写、不抽组件
- **paddingTop**：`insets.top + 54` → `insets.top + 16`
- **日期分隔**：`renderItem` 内检测 `prev.date !== item.date` → 插入 `DateSeparator`（居中、12px、灰色、复用 `formatDateLabel`）
- **修复 `visibleMessages` 跨日期 pending 阻断**：日期变化时重置 `blocked = false`
- **跳转逻辑**：`pendingJumpId` + Modal `onClosed` 回调（不用 `setTimeout`），`scrollToIndex` fallback 用 `scrollToOffset({ estimatedOffset: index * 80 })` 估算位置
- **初始加载**：`useEffect` 调 `loadAllMessages` + `loadDates`
- **保留**：`isSending` 滚动逻辑、`onContentSizeChange` 自动滚底

### Step 6: 新建 SearchModal
- 文件：`frontend/src/components/chat/search-modal.tsx`（新建）
- 全屏 Modal（`animationType="fade"`），毛玻璃背景
- 顶栏：「取消」按钮 + 「搜索聊天记录」标题
- 搜索框：`TextInput`（autoFocus），输入时空状态隐藏、显示结果
- 空搜索词时：显示「📅 按日期查找」入口 → 内联 `DateTimePicker`（复用 `@react-native-community/datetimepicker`，90 天前到今天）
- 有搜索词时：纯内存过滤 `allMessages.filter(m => m.content?.includes(q)).slice(0, 50)`，按日期分组渲染（复用 `formatDateLabel` + `formatChatTime`）
- 点击结果 → `onJumpToMessage(msgId)` → `onClose()`
- 选日期 → `onJumpToDate(date)` → `onClose()`
- `onDismiss` → `onClosed`（触发跳转回调）

### Step 7: 清理
- **删除** `frontend/src/components/chat/date-selector.tsx`
- **更新** `frontend/src/test/mocks.ts`：移除 `setDate`、`loadForDate`，新增 `loadAllMessages: jest.fn()`
- **不动** `getCachedMessages`（dead code 但保留）、`pruneOldMessages`（本来就是 dead code）

## 验收

### 不破坏现有功能
- [ ] `POST /api/chat/message` 发消息正常
- [ ] `POST /api/pending/:id/resolve` 选份量/食物正常
- [ ] `POST /api/records/:id/undo` 撤销正常
- [ ] `GET /api/chat/messages?date=` 单日查询正常（旧端点未改动）
- [ ] Today / History / Settings 页面正常
- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm test` 22/22 通过

### 新功能
- [ ] 首次打开 chat tab → 先显示问候语（无缓存）或缓存消息 → 加载完成后全量消息 + 日期分隔
- [ ] 右上角搜索按钮显示正常（毛玻璃圆形，和 back 按钮视觉一致）
- [ ] 点击搜索按钮 → 弹出搜索弹窗
- [ ] 输入关键词 → 实时过滤结果，按日期分组
- [ ] 点搜索结果 → 弹窗关闭 → FlatList 滚到目标消息（居中）
- [ ] 「按日期查找」→ 选日期 → FlatList 滚到该日第一条
- [ ] 跨日期上滑 → 日期分隔自然过渡
- [ ] 发新消息 → append 不闪 → scrollToEnd

### 代码质量
- [ ] 无未使用的 import / 函数 / 变量
- [ ] 无 service / Repository / Base 类
- [ ] 复用现有 API：`toDateOnly`、`formatDateLabel`、`Glass`、`localDateStr`、`upsertMessages`、`formatChatTime`

## 给 Claude Code 的提示词

> 参考 CLAUDE.md、docs/API_SPEC.md、docs/DESIGN_SPEC.md §3。只做任务 T26：聊天搜索 + 数据本地化重构。详细方案在 `.claude/plans/wondrous-watching-sprout.md`，按 7 步顺序执行。硬边界：不碰核心聊天 API（POST /api/chat/message、POST /api/pending/:id/resolve、POST /api/records/:id/undo），不修改现有 GET /api/chat/messages?date=，不写冗余抽象，不碰卡片组件。改完自测验收：TypeScript 零错误、22 测试通过、旧端点不变。
