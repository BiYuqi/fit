# T57 — 全页面 SQLite 持久化缓存：去转圈

**状态**：🔄重写完成，待真机重验（2026-07-10 设计重写：删键失效 → 写穿 + 共享 hook）

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

> **首版返工记录（2026-07-10）**：首版把「Chat 操作后失效 Today 缓存」实现为**删键**——结果冷启动后在 Chat 记一笔再切 Today 必然缓存 miss 转圈，恰好打在最高频路径上，任务目标在主流程失效；且同一加载模式在 4 个文件手写了 4 遍、各自走样（History 切粒度时旧粒度数据顶着新标签渲染）。本版重写为**写穿 + 共享 hook**。

## 方案设计

### SQLite 表

`fit_cache.db` 一张轻量 KV 表（数据本身就是 JSON 往返，存 JSON 最直接）：

```sql
CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**GC**：`getDb()` 初始化时删除 `updated_at` 超过 14 天的行——`today|日期`、`range|滚动窗口` 这类日期键每天生成新键，不清理会无限增长。

### Cache Key 设计

| Key | 数据 | 一致性策略 |
|-----|------|----------|
| `profile` | `GET/PUT /api/user/profile` | PUT 成功后 `mutate` 写穿；logout 清整表 |
| `today\|2026-07-08` | `GET /api/daily/today` | Chat send/resolve/undo 成功后用响应的 `summary_card` **写穿**（见下）；日期入键跨天自动隔离 |
| `range\|day\|02\|08` | `GET /api/daily/range` | SWR：先渲染缓存，后台刷新触达真值（范围**含今天**，今天的柱子靠刷新更新） |
| `records\|02\|08` | `GET /api/daily/records` | 同上 |

> **Why date in key?** `today` 若不带日期，23:59 的缓存会被次日 00:01 打开 App 时误读。带日期后跨天自动隔离。

### 共享 hook：`useCachedQuery`（`src/hooks/use-cached-query.ts`）

四块数据同一模式，**只写一遍**：

```
useCachedQuery(key, fetcher):
  key 就绪/变化 → 读 SQLite
     ├─ 命中 → data=cached，loading=false（秒出，不转圈）
     └─ 未命中 → data=null，保持 loading（不许旧 key 数据顶着新 key 标签渲染）
  随后后台 fetch → setCached → data=fresh（静默更新，不置 loading）
  失败：有数据可展示则无感知；无数据才置 error
```

暴露：`refetch()`（Tab 激活时静默刷新，同 key 并发去重）、`refresh()`（下拉刷新带 refreshing 态）、`mutate(next, persist?)`（PUT 成功回填；乐观值 persist=false 不进缓存）。内置 key 切换竞态防护（迟到响应丢弃）。

### Chat 操作后 Today 一致性：写穿，不删键

send / resolve / undo / undoEvent 的响应都带 `summary_card`（ContextCard），其 `today.in/out/deficit/p/f/c` 与 `targets` 正是 Today 页 `DailySummary` 的主体字段。成功路径调 `patchTodayCache(res.summary_card)`（`src/lib/today-cache.ts`）把这些字段写进 `today|日期` 缓存——切到 Today **秒出且数字已是新的**。

ContextCard 缺 `tdee` / `exercise_out` / `exercises`：保留缓存原值（tdee 只随档案变；运动明细靠 Today 激活后的后台刷新触达真值）。缓存不存在或当天还没 summary 时跳过（缺字段不合成），走网络首载。

### Profile 跨组件共享 + React Query 下线

`_layout.tsx` 与 `settings.tsx` 共用 key `profile`。React Query 唯一用途（layout 的 profile useQuery）被 hook 替代后，**连 Provider 带依赖一起移除**（`query-client.ts` 删除，`@tanstack/react-query` 卸载）——不留只剩空壳的依赖。

onboarding 完成 → `refetchProfile()`；settings 保存 → `mutate(updated)` 写穿缓存。
_layout 冷启动无缓存且请求失败时渲染「加载失败 + 重试」，不再白屏。

### 登出清除（换号无泄漏）

`logout()`：`clearApiCache()`（api_cache 整表）+ `clearCache()`（chat_messages 表）+ `useChatStore.reset()`（zustand 内存态跨卸载存活，不清会把上个账号的聊天流渲染给新账号）。

## 侵入面

| 文件 | 改动 |
|------|------|
| `src/hooks/use-cached-query.ts` | **新增**：统一缓存优先加载 hook |
| `src/lib/today-cache.ts` | **新增**：`todayCacheKey` + `patchTodayCache`（ContextCard 写穿） |
| `src/types/daily.ts` | **新增**：`DailySummary/ExerciseRecord/TodayResponse`（Today 页与写穿共用） |
| `src/lib/db.ts` | `api_cache` 表 + `getCached/setCached/clearApiCache` + 14 天 GC |
| `src/app/_layout.tsx` | profile 走 hook；React Query 移除；失败重试兜底 |
| `src/app/today.tsx` | 数据加载全交 hook（~40 行 → ~8 行） |
| `src/app/history.tsx` | range/records 两个 hook 实例；粒度入 key |
| `src/app/settings.tsx` | profile 走 hook（与 _layout 共键）；保存走 mutate；接 isActive 激活刷新 |
| `src/stores/chat-store.ts` | 四个成功路径 `patchTodayCache` + `reset()` |
| `src/stores/auth-store.ts` | logout 清 api_cache + chat_messages + chat-store 内存态 |
| `src/lib/query-client.ts` | **删除**（连同 `@tanstack/react-query` 依赖） |

## 验收

1. **冷启动秒出**：杀掉 App 重新打开 → Today / History / Settings 直接显示上次数据，不转圈
2. **切 Tab 不转圈**：Chat ↔ Today ↔ History ↔ Settings 之间切换瞬间显示，无 spinner——**含「冷启动 → Chat 记一笔 → 切 Today」这条主路径**（首版在这里转圈）
3. **Chat 操作后 Today 数字即时正确**：记餐/撤销后切 Today，环形卡热量/宏量素已是新值（写穿），运动明细最迟后台刷新跟上
4. **History 粒度切换**：访问过的粒度瞬间显示；未访问过的正确转圈，**不会**拿旧粒度数据顶新标签渲染
5. **后台静默刷新**：页面打开后数据自动更新到最新，无 loading 闪烁
6. **断网可用**：飞行模式下 Today / History / Settings 显示缓存数据不白屏；冷启动无缓存 + 断网 → 显示「加载失败 + 重试」
7. **换号无泄漏**：退出登录换号 → 旧号的 Today/History/Profile 缓存、聊天记录（SQLite + 内存）全部不可见
8. **Profile 修改后同步**：Settings 改体重 → Today 后台刷新拿到新目标值
9. `cd frontend && npm test` 全绿；`npx tsc --noEmit` 无新增错误
