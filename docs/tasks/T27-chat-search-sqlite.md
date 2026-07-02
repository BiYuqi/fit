# T27 — 聊天搜索改为 SQLite 方案（微信式窗口定位）

**状态**：✅完成  <!-- ⬜待办 / 🔄进行中 / ✅完成 -->

**目标**：T26 搜索走 `allMessages.filter()` 纯内存，列表渲染 90 天全量消息。改为微信式：搜索走 SQLite LIKE、日常浏览走精确范围窗口加载、跳转时替换为目标周围的居中窗口。
**依赖**：T26（SQLite 已有全量 `chat_messages`、`messages/range` 端点已就绪）
**关注文档**：API_SPEC.md §聊天记录，ARCHITECTURE.md §5

## 现有渲染模型（不动）

```
messages (store):     [oldest, ..., newest]    ← chronological，SQLite 返回
visibleMessages:      [newest, ..., oldest]    ← filter(messages).reverse()
FlatList inverted:     index 0 在底部，last 在顶部
→ 视觉效果:             oldest 在顶，newest 在底  ← 正常聊天
```

**为什么是 inverted + reverse**：新消息 append 到 messages 尾部 → reverse 后出现在 visibleMessages[0] → inverted 渲染在底部，**不需要 scrollToEnd**。上翻到顶触发 onEndReached → 加载更早消息。微信 / iMessage 都是这个模式。不动。

## 硬边界

1. 不碰后端（`messages/range` 端点不变）
2. 不碰卡片组件（message-item 等 8 个零改动）
3. 不碰聊天交互（send / resolve / undo 逻辑不变）
4. 不碰 inverted + reverse 渲染模型
5. 搜索弹窗布局/样式不动，只换数据源

## 两种窗口的区别

| 场景 | 函数 | 语义 |
|------|------|------|
| 初始加载 | `getMessagesInRange(from, to)` | 精确范围：今天往前 N 天 |
| 上翻加载 | `getMessagesInRange(from, to)` | 精确范围：更早 N 天，`to < 当前最早日期` |
| 搜索跳转 | `getMessagesAround(date, N)` | 居中窗口：目标日期 ± N 天 |

## Step 1: db.ts 新增三个 SQLite 函数

文件：`frontend/src/lib/db.ts`（加在 `clearCache` 之后）

```typescript
/**
 * 精确日期范围查询。from/to 均包含。
 */
export async function getMessagesInRange(
  from: string,
  to: string,
): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MessageRow>(
    `SELECT * FROM chat_messages
     WHERE date >= ? AND date <= ?
     ORDER BY date ASC, created_at ASC`,
    [from, to],
  );
  return rows.map(parseRow);
}

/**
 * 居中窗口查询。用于搜索跳转——加载目标日期前后各 windowDays 天的消息。
 */
export async function getMessagesAround(
  date: string,
  windowDays = 3,
): Promise<ChatMessage[]> {
  const d = new Date(date + 'T12:00:00');
  const from = new Date(d);
  from.setDate(from.getDate() - windowDays);
  const to = new Date(d);
  to.setDate(to.getDate() + windowDays);
  return getMessagesInRange(
    from.toISOString().slice(0, 10),
    to.toISOString().slice(0, 10),
  );
}

/**
 * 搜索消息 — SQLite LIKE，按日期倒序。
 */
export async function searchMessages(
  query: string,
  limit = 50,
): Promise<ChatMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MessageRow>(
    `SELECT * FROM chat_messages
     WHERE content LIKE ?
     ORDER BY date DESC, created_at DESC
     LIMIT ?`,
    [`%${query}%`, limit],
  );
  return rows.map(parseRow);
}
```

再加一个轻量 helper（给 `jumpToMessage` 用，避免 store 里裸写 SQL）：

```typescript
/** 根据 id 查消息日期。不存在返回 null。 */
export async function getMessageDateById(id: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ date: string }>(
    'SELECT date FROM chat_messages WHERE id = ?',
    [id],
  );
  return row?.date ?? null;
}
```

四个函数 ~40 行。`getMessagesInRange` 是基础，`getMessagesAround` 调用它。store 不直接碰 `getDb()`。

## Step 2: chat-store 重构

文件：`frontend/src/stores/chat-store.ts`

### 状态变化

```diff
- import { getAllMessages, upsertMessages } from '@/lib/db';
+ import { getMessagesInRange, getMessagesAround, getMessageDateById, upsertMessages } from '@/lib/db';

type ChatStore = {
  messages: ChatMessage[];          // 改：当前窗口（非全量）
  isLoading: boolean;
  isSending: boolean;
  chatDates: string[];
  summaryCard: ContextCard | null;
  resolvedPendings: Record<string, true>;
  undoneCards: Record<string, true>;
+ jumpTarget: { type: 'message'; id: string }
+           | { type: 'date'; date: string }
+           | null;                       // 跳转目标，组件 useEffect 消费后清除

- loadAllMessages: (token: string) => Promise<void>;
+ loadRecentMessages: (token: string) => Promise<void>;
+ loadMoreMessages: () => Promise<void>;
+ jumpToMessage: (messageId: string) => Promise<void>;
+ jumpToDate: (date: string) => Promise<void>;
+ clearJumpTarget: () => void;
  loadDates: (token: string) => Promise<void>;  // 不变
  send: ...;       // 不变
  resolve: ...;    // 不变
  undo: ...;       // 不变
};
```

初始值新增：`jumpTarget: null`

### `loadRecentMessages`（替代 `loadAllMessages`）

```typescript
loadRecentMessages: async (token: string) => {
  set({ isLoading: true });

  const to = todayStr();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 6);  // 7 天显示窗口
  const from = localDateStr(fromDate);

  // 1. SQLite 读显示窗口（秒渲染 — 数据 T26 已全量缓存）
  try {
    const cached = await getMessagesInRange(from, to);
    if (cached.length > 0) set({ messages: cached });
  } catch { /* ignore */ }

  // 2. 服务端同步（只补今天的新消息，不急拿 90 天 — SQLite 里已有）
  try {
    const data = await apiFetch<{ messages: ChatMessage[]; resolved_pending_ids?: string[] }>(
      `/api/chat/messages/range?from=${from}&to=${to}`,
      { token },
    );
    const byDate = new Map<string, ChatMessage[]>();
    for (const m of data.messages) {
      const list = byDate.get(m.date);
      if (list) list.push(m);
      else byDate.set(m.date, [m]);
    }
    for (const [date, msgs] of byDate) {
      await upsertMessages(date, msgs);
    }
    const resolvedFromServer: Record<string, true> = {};
    for (const id of data.resolved_pending_ids ?? []) {
      resolvedFromServer[id] = true;
    }
    // 3. 重读窗口（含服务器刚写入的新消息）
    const window = await getMessagesInRange(from, to);
    set(s => ({
      messages: window,
      resolvedPendings: { ...s.resolvedPendings, ...resolvedFromServer },
    }));
  } catch { /* keep cache on error */ }

  set({ isLoading: false });
},
```

**为什么不同步 90 天**：SQLite 已有 T26 缓存的全量数据。`loadMoreMessages`、`searchMessages`、`jumpToMessage` 都读 SQLite，不走服务端。服务端只补今天的新消息。

### `loadMoreMessages`（上翻加载更早消息）

```typescript
loadMoreMessages: async () => {
  const { messages } = get();
  if (messages.length === 0) return;

  const earliestDate = messages[0].date;  // chronological，index 0 = 最早
  const toDate = new Date(earliestDate + 'T12:00:00');
  toDate.setDate(toDate.getDate() - 1);   // 不重叠：查到 earliestDate - 1
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 6); // 往前 7 天

  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr = toDate.toISOString().slice(0, 10);

  let older = await getMessagesInRange(fromStr, toStr);

  // SQLite 为空（重装后首次）→ fallback 服务端
  if (older.length === 0) {
    try {
      const token = useAuthStore.getState().token;
      if (token) {
        const data = await apiFetch<{ messages: ChatMessage[] }>(
          `/api/chat/messages/range?from=${fromStr}&to=${toStr}`,
          { token },
        );
        if (data.messages.length > 0) {
          const byDate = new Map<string, ChatMessage[]>();
          for (const m of data.messages) {
            const list = byDate.get(m.date);
            if (list) list.push(m);
            else byDate.set(m.date, [m]);
          }
          for (const [date, msgs] of byDate) {
            await upsertMessages(date, msgs);
          }
          older = await getMessagesInRange(fromStr, toStr);
        }
      }
    } catch { /* stay empty */ }
  }

  if (older.length > 0) {
    set({ messages: [...older, ...messages] });
    // chronological prepend → visibleMessages 尾部追加 → inverted 顶部显示
  }
},
```

去重保证：
- `to = earliestDate - 1`，不和当前窗口重叠
- store 加 `_loadingMore: boolean` 内部标记（不暴露给组件），`loadMoreMessages` 开始时检查，防止 `onEndReached` 并发触发

### `jumpToMessage`（搜索结果跳转）

```typescript
jumpToMessage: async (messageId: string) => {
  const targetDate = await getMessageDateById(messageId);
  if (!targetDate) return;
  const window = await getMessagesAround(targetDate, 3);
  set({ messages: window, jumpTarget: { type: 'message', id: messageId } });
},
```

### `jumpToDate`（按日期跳转）

```typescript
jumpToDate: async (date: string) => {
  const window = await getMessagesAround(date, 3);
  set({ messages: window, jumpTarget: { type: 'date', date } });
},
```

### `clearJumpTarget`

```typescript
clearJumpTarget: () => set({ jumpTarget: null }),
```

### send / resolve / undo — 不动

`send` 仍然 append 到 messages 尾部（今天在窗口内）。`resolve` 仍然 splice 到 pending 卡后。逻辑不变。

## Step 3: search-modal 改造

文件：`frontend/src/components/chat/search-modal.tsx`

### Props 变化

```diff
+ import { searchMessages } from '@/lib/db';  // 顶部静态 import

type Props = {
  visible: boolean;
  onClose: () => void;
- onClosed: () => void;
- allMessages: ChatMessage[];
- onJumpToMessage: (messageId: string) => void;
- onJumpToDate: (date: string) => void;
+ onSearchResult: (messageId: string) => void;
+ onDateSelect: (date: string) => void;
};
```

### 搜索逻辑

```diff
- const results = useMemo(() => {
-   return allMessages.filter(m => m.content?.includes(q)).slice(0, 50);
- }, [searchQuery, allMessages]);

+ const [results, setResults] = useState<ChatMessage[]>([]);
+
+ useEffect(() => {
+   if (!searchQuery.trim()) { setResults([]); return; }
+   let cancelled = false;
+   searchMessages(searchQuery, 50).then(rows => {
+     if (!cancelled) setResults(rows);
+   });
+   return () => { cancelled = true; };
+ }, [searchQuery]);
```

### 结果点击回调

```diff
- onPress={() => { onJumpToMessage(item.id); onClose(); }}
+ onPress={() => onSearchResult(item.id)}
```

布局、样式、DateTimePicker、`renderResult`（日期分组）全部不动。

## Step 4: ChatScreen 改造

文件：`frontend/src/app/index.tsx`

### import 变化

三处调整：
- 删 `loadAllMessages`，换 `loadRecentMessages` + `loadMoreMessages` + `jumpToMessage` + `jumpToDate` + `jumpTarget` + `clearJumpTarget`
- `formatChatTime` / `formatDateLabel` / `CHAT_TIME_GAP_MS` 不变
- 加 `localDateStr`（isActive useEffect 判断窗口是否含今天）

### store 解构

```diff
const {
  messages,
  isSending,
  isLoading,
  chatDates,
  resolvedPendings,
- loadAllMessages,
+ loadRecentMessages,
+ loadMoreMessages,
+ jumpToMessage,
+ jumpToDate,
+ jumpTarget,
+ clearJumpTarget,
  loadDates,
  send,
} = useChatStore();
```

### 删除

```diff
- const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
- const [pendingJumpDate, setPendingJumpDate] = useState<string | null>(null);
- const handleJumpToMessage = ...
- const handleJumpToDate = ...
- const handleModalClosed = ...
```

### 新增：搜索回调 + jumpTarget 响应

```typescript
// 搜索回调：关弹窗 → 加载窗口（异步，store 设 jumpTarget）
const handleSearchResult = useCallback((messageId: string) => {
  setSearchOpen(false);
  jumpToMessage(messageId);
}, [jumpToMessage]);

const handleDateSelect = useCallback((date: string) => {
  setSearchOpen(false);
  jumpToDate(date);
}, [jumpToDate]);

// 响应 jumpTarget：messages 更新 → visibleMessages recompute → scroll
useEffect(() => {
  if (!jumpTarget) return;
  let idx = -1;
  if (jumpTarget.type === 'message') {
    idx = visibleMessages.findIndex(m => m.id === jumpTarget.id);
  } else {
    // visibleMessages 是 reverse（新→旧），同日期第一条 chronological
    // = 同日期中 index 最大的（最靠近数组尾部）
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].date === jumpTarget.date) { idx = i; break; }
    }
  }
  if (idx >= 0) {
    flatListRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
  }
  clearJumpTarget();
}, [jumpTarget, visibleMessages, clearJumpTarget]);
```

### 初始加载

```diff
useEffect(() => {
  if (!token) return;
- loadAllMessages(token);
+ loadRecentMessages(token);
  loadDates(token);
}, [token]);
```

### SearchModal props

```diff
<SearchModal
  visible={searchOpen}
  onClose={() => setSearchOpen(false)}
- onClosed={handleModalClosed}
- allMessages={messages}
+ onSearchResult={handleSearchResult}
+ onDateSelect={handleDateSelect}
  chatDates={chatDates}
- onJumpToMessage={handleJumpToMessage}
- onJumpToDate={handleJumpToDate}
/>
```

### FlatList

```diff
<FlatList
  ref={flatListRef}
  inverted
+ onEndReached={loadMoreMessages}
+ onEndReachedThreshold={0.3}
  ...
/>
```

### isActive useEffect

T26: `scrollToIndex(0)` = 全量最新 = 今天。T27 跳转后 messages 是历史窗口，index 0 不是今天。

```diff
+ import { localDateStr } from '@/lib/format';  // 新增

useEffect(() => {
  if (isActive && visibleMessages.length > 0) {
-   flatListRef.current?.scrollToIndex({ index: 0, animated: false });
+   // 窗口不含今天（搜索跳转后的历史窗口）→ 先重载
+   if (!visibleMessages.some(m => m.date === localDateStr())) {
+     if (token) loadRecentMessages(token);
+     return;
+   }
+   flatListRef.current?.scrollToIndex({ index: 0, animated: false });
  }
- }, [isActive]);
+ }, [isActive, token, loadRecentMessages, visibleMessages]);
```

## Step 5: 清理

### 修改

- `frontend/src/test/mocks.ts`：`ChatStoreState` 接口替换 `loadAllMessages` → `loadRecentMessages`，新增 `jumpToMessage: jest.fn()`、`jumpToDate: jest.fn()`、`loadMoreMessages: jest.fn()`、`jumpTarget: null`、`clearJumpTarget: jest.fn()`
- `docs/ARCHITECTURE.md` §5：更新为"窗口加载 + SQLite 搜索"

### 保留

- `getCachedMessages`：dead code，无副作用，保留
- `getAllMessages`：不再被任何 action 调用，debug 可能有用，保留
- `upsertMessages`：被 `loadRecentMessages`、`send`、`resolve` 使用，不动

### 删除

- `date-selector.tsx` 已在 T26 删除，无需再处理

## 验收

### 不破坏
- [ ] 发消息 → append 到列表底部，不闪
- [ ] resolve / undo → 正常
- [ ] 首次进 Chat → 显示最近 7 天缓存 → 服务端同步 → 日期分隔正常
- [ ] 上翻到顶 → onEndReached → 加载更早 7 天 → 无重复 → 日期分隔延续
- [ ] Today / History / Settings 正常
- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm test` 全部通过

### 新行为
- [ ] 搜索弹窗 → 输入关键词 → 查 SQLite → 按日期分组显示
- [ ] 点搜索结果 → 弹窗关闭 → 列表替换为目标 ±3 天窗口 → 滚到目标消息
- [ ] 按日期查找 → 弹窗关闭 → 列表替换为该日 ±3 天窗口 → 滚到该日第一条
- [ ] 搜索无结果 → "未找到"
- [ ] 跳转后上翻 → onEndReached 仍可加载更早消息

### 代码质量
- [ ] 无 service / Repository / Base 类
- [ ] `search-modal.tsx` 不接收 `allMessages` prop
- [ ] `getMessagesInRange` 是唯一基础查询函数，`getMessagesAround` 调用它
- [ ] inverted + reverse 模型不变
