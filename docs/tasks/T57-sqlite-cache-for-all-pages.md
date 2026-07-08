# T57 — 全页面 SQLite 持久化缓存：去转圈

**状态**：⬜待办

**目标**：Today / History / Settings / Profile 四块数据全部走 SQLite 缓存（对标 Chat 已有的本地优先模式），消除每次切 Tab 的全屏 loading 转圈。关了 App 再打开也秒出。

**依赖**：无硬依赖（纯前端改动，不动后端 API）
**关注文档**：`docs/ARCHITECTURE.md` §7（本地缓存/同步）

## 背景

Chat 已经在 T26 完成了 SQLite 缓存（`chat_messages` 表 + 先读本地秒出 → 后台 API 静默刷新的模式），但另外四个数据入口仍然是"每次激活 setLoading(true) → 转圈 → API 回来 → 渲染"：

| 页面 | API | 痛点 |
|------|-----|------|
| Today | `GET /api/daily/today` | 每次切 Tab 转圈 |
| History | `GET /api/daily/range` + `GET /api/daily/records` | 每次切 Tab + 每次切粒度都转圈 |
| Settings | `GET /api/user/profile` | 每次进设置页转圈（而且 layout 已经拉过一份 profile） |
| AppShell (profile) | `GET /api/user/profile` | 冷启动等 profile 才渲染 AppTabs |

微信式体验的核心逻辑：**数据早就在本地，打开直接渲染，网络请求在后台静默完成**。

## 方案设计

### SQLite 表

在 `fit_cache.db` 新增一张轻量 KV 表（不建结构化表——数据本身就是 JSON 往返，存 JSON 最直接）：

```sql
CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Cache Key 设计

| Key | 数据 | 变动频率 | 失效策略 |
|-----|------|----------|----------|
| `profile` | `GET/PUT /api/user/profile` | 极低 | logout 时清整表；PUT 成功后覆盖 |
| `today\|2026-07-08` | `GET /api/daily/today` | 高 | Chat send/resolve/undo 成功后删除；跨天 key 自动隔离 |
| `range\|day\|2026-07-02\|2026-07-08` | `GET /api/daily/range` | 极低（过去日期不可变） | 无需失效 |
| `records\|2026-07-02\|2026-07-08` | `GET /api/daily/records` | 极低（同上） | 无需失效 |

> **Why date in key?** `today` 若不带日期，23:59 的缓存会被次日 00:01 打开 App 时误读。带了日期后跨天自动隔离，连主动失效都不是必须的（但我们仍然做主动失效以避免切 Tab 时 200ms 的陈旧闪烁）。

### 统一缓存优先模式

四块数据全部使用同一模式（和 Chat 的 `loadRecentMessages` 同构）：

```
load():
  1. 读 SQLite
     ├─ 命中 → setState(cached) → 页面秒出（0ms），loading=false
     └─ 未命中（首次冷启动）→ loading 保持 true → 骨架占位

  2. 后台调 API（不阻塞渲染）
     ├─ 成功 → 写 SQLite → setState(fresh) → UI 静默更新
     └─ 失败 → 保留缓存数据，用户无感知
```

关键：**第 2 步不设 setLoading(true)，不转圈**。

### Profile 跨组件共享

`_layout.tsx` 和 `settings.tsx` 都需要 profile。同一份 SQLite key `profile`：
- `_layout.tsx` 先读（冷启动第一个渲染），写入 SQLite
- `settings.tsx` 再读时 SQLite 已有数据，瞬间返回，零网络请求

**`_layout.tsx` 去 React Query**：当前 `useQuery(['profile'])` 是纯内存缓存，关了 App 就没了。改为手动 fetch + SQLite，和另外三块同一模式。`queryClient` 仅保留（不动它，万一别处用到）。

**onboarding 刷新**：`handleOnboardingComplete` 需要重新拉 profile（确认 `onboarded` 翻为 true）。用一个 `profileVersion` 计数器，onboarding 完成 / settings 保存后 bump，触发 `_layout.tsx` 重新 load。

### 主动失效

Chat 操作（记餐/确认/撤销）成功后，主动删 `today|<date>` 缓存。在 `chat-store.ts` 四个 action 的成功路径里加一行 `delCached`：

| Action | 失效 |
|--------|------|
| `send` | `delCached('today|<today>')` |
| `resolve` | 同上 |
| `undo` | 同上 |
| `undoEvent` | 同上 |

### 登出清除

`auth-store.ts` 的 `logout()` 调用 `clearApiCache()`（新增），清空 `api_cache` 整表，防止换账号后读到上个人的数据。

## 侵入面

| 文件 | 改动 | 侵入量 |
|------|------|--------|
| `src/lib/db.ts` | 加 `api_cache` 表 + `getCached` / `setCached` / `delCached` / `clearApiCache` | +30 行 |
| `src/app/_layout.tsx` | profile 从 React Query 改为手动 SQLite 优先 | 重构 ~30 行 |
| `src/app/today.tsx` | `load()` 读缓存秒出 + 后台刷新，去全屏转圈 | ~20 行改 |
| `src/app/history.tsx` | 同上，key 带粒度+日期范围 | ~25 行改 |
| `src/app/settings.tsx` | `load()` 读缓存秒出，去手动 fetch | ~15 行改 |
| `src/stores/chat-store.ts` | send/resolve/undo/undoEvent 成功后 `delCached(todayKey)` | +5 行 |
| `src/stores/auth-store.ts` | `logout()` 加 `clearApiCache()` | +2 行 |

## 验收

1. **冷启动秒出**：杀掉 App 重新打开 → Today / History / Settings 直接显示上次数据，不转圈
2. **切 Tab 不转圈**：Chat ↔ Today ↔ History ↔ Settings 之间切换，每次都是瞬间显示，无 loading spinner
3. **后台静默刷新**：页面打开后数据自动更新到最新（网络正常时 200-500ms 内刷新）
4. **Chat 操作后 Today 新鲜**：在 Chat 记了一条餐 → 切到 Today → 数据已更新（无陈旧闪烁）
5. **History 粒度切换**：日/周/月之间切换，已访问过的粒度瞬间显示（从缓存），新粒度走网络
6. **断网可用**：开飞行模式 → Today / History / Settings 显示缓存数据，不白屏
7. **换号无泄漏**：退出登录换另一个号 → 旧号的 Today/History/Profile 缓存被清除
8. **Profile 修改后同步**：Settings 修改体重 → 切回 Today → Today 的目标热量基于新体重重新计算（因为 Today 读 API 会拿到新目标值）
