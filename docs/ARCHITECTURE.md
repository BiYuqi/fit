# ARCHITECTURE — 系统架构

> 本文件讲技术与结构。字段语义见 DATA_MODEL；接口见 API_SPEC；公式见 CALORIE_ENGINE。

## 1. 总览与数据流

```
[Expo RN 前端]
   │  HTTPS (JWT)
   ▼
[Fastify 后端 API]  ── 调用 ──> [DeepSeek V4]（只理解/估算，不算账）
   │
   ├─ 计算引擎（唯一算账处）
   ├─ 食物匹配（pg_trgm）
   ▼
[PostgreSQL]  ← 事实源：food_record / daily_summary / food_standard
                        展示层：chat_message
```

记录一餐的链路：前端发文本 → 后端调 DeepSeek 解析（意图+食物+份量+置信度）→ 匹配食物库 → 计算引擎算热量 → 写 food_record → 刷新 daily_summary → 同时写 chat_message（用户气泡 + 卡片）→ 返回反馈 + 最新汇总卡。

## 2. 事实层 vs 展示层（核心架构原则）
- **事实层**：`food_record`、`daily_summary`、`food_standard`。所有数字真相在此。Today/History 只读这层。
- **展示层**：`chat_message`。聊天气泡与卡片的回放，仅供 Chat 页显示。**任何统计绝不读它。** 删除聊天不影响事实层。

这条原则保证"DB 唯一真相"成立，同时聊天可持久化、可回看。

## 3. 仓库结构

```
项目根/
├── CLAUDE.md            # 宪法（铁律+索引+运行）
├── start.sh             # 一键启动
├── docs/                # 全部文档
├── backend/             # 独立 npm 项目（Fastify）
│   ├── src/{routes,services,ai,plugins}
│   ├── prisma/schema.prisma
│   └── scripts/seed/
└── frontend/            # 独立 npm 项目（Expo RN）
    └── app/(tabs)/{chat,today,history,settings}
```

**为什么 backend 与 frontend 是两个独立 npm 项目、不用 workspaces**：两端依赖树、构建、部署完全不同；Expo 的 Metro 打包器对 workspace 软链支持较糙，易踩坑。它们之间唯一要共享的是 API 字段，靠 `docs/API_SPEC.md` 作为单一契约源对齐即可，不值得为此引入 workspace 复杂度。

## 4. 技术栈

### 前端（frontend/）
| 维度 | 选型 | 理由 |
|---|---|---|
| 框架 | React Native + Expo (SDK 53+) | 免原生配置，EAS 云构建/OTA |
| 路由 | Expo Router | 文件路由覆盖四个 Tab |
| 服务端状态 | TanStack Query | 接口缓存/失效/乐观更新 |
| 本地状态 | Zustand | 当前用户、上下文卡 |
| 样式 | NativeWind v4 | 类 Tailwind |
| 毛玻璃/动效 | expo-blur + reanimated 3 | Liquid Glass 质感 |
| 语音转文字 | @react-native-voice/voice | 设备 STT，需 Dev Build；后端只收文本 |
| 本地缓存 | expo-sqlite | 缓存最近聊天（见 §5） |
| Token | expo-secure-store | 安全存 JWT |
| 图表 | react-native-gifted-charts | History 趋势 |

### 后端（backend/）
| 维度 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node 20+ / TS | I/O 密集，Node 合适 |
| 框架 | Fastify | 轻、快、插件全 |
| DB | PostgreSQL 16 + pg_trgm | 关系型 + 模糊匹配，免向量库 |
| ORM | Prisma 7 + `@prisma/adapter-pg` | 类型安全、迁移好；v7 driver adapter 模式，连接配置在 `prisma.config.ts`，运行时通过 `src/lib/prisma.ts` 单例访问 |
| 认证 | 自建 JWT + argon2 | 账号密码极简 |
| 校验 | zod | 请求 + DeepSeek 返回 |
| AI | openai SDK 接 DeepSeek V4；统一入口 `ai/ctx.ts`（`callDeepSeekCtx`） | 见 AI_PARSING_SPEC §7 |
| 日志 | pino | Fastify 内置 |

## 5. 本地缓存与同步（数据本地化 + SQLite 搜索）

- 服务端 Postgres 是聊天记录的**权威副本**；本地 SQLite 是镜像缓存（全量 90 天）。
- 进 Chat 页：读本地 SQLite **7 天窗口**秒显示（`getMessagesInRange`），再调服务端同步今日新消息、写入 SQLite。FlatList 只渲染当前窗口，不渲染全量。
- **上翻加载**：`onEndReached` → 查 SQLite 加载更早 7 天窗口、prepend 到列表。SQLite 无数据时 fallback 服务端。
- **搜索走 SQLite LIKE**：`searchMessages` 直接查 `chat_messages` 表返回摘要，不依赖内存数组。结果点选后调 `getMessagesAround` 加载目标 ±3 天窗口替换列表。
- **跳转走窗口替换**：`jumpToMessage` / `jumpToDate` → SQLite 读目标窗口 → 替换 FlatList 数据 → `scrollToIndex` 定位。
- FlatList 使用 `inverted` + `reverse`（微信模式）：新消息自动在底部出现，无需手动 scrollToEnd。
- 离线：可看本地缓存的历史；但**记录新食物需联网**（要调 DeepSeek），离线只读不写。
- "清除本地缓存"只删本地镜像，服务端不动，重进可拉回。

## 6. 聊天记录保留策略（机制）
- 服务端：`chat_message` 带 `created_at`，每日定时任务删除 **365 天前**的聊天行。
- **只清 `chat_message`，绝不级联 `food_record`/`daily_summary`**：一年前对话被清后，那天的热量统计与 History 数字照常保留。
- 本地：超过 30 天的缓存自动清，无需用户操作。

## 7. 部署
| 部分 | 方案 |
|---|---|
| 数据库 | **前期：本地 Docker Postgres**（`./start.sh db`）；**上线：任意 Postgres**（自建 VPS / Railway / Render / Neon / 云 RDS 均可，非必须 Neon）。同一引擎，换谁只改 `.env` 的 `DATABASE_URL` 一行，代码零改动 |
| 后端 | Docker 容器 → Fly.io / Railway / Render / VPS |
| 前端 | Expo EAS Build 出包 + EAS Update OTA |
| 定时清理 | 部署平台的 cron（或后端内置调度）跑保留策略 |

### 7.1 为什么主库选 PostgreSQL（地基决策）
不是跟风，是它一站式覆盖本项目三个硬需求：
1. **`pg_trgm` 模糊匹配**——食物匹配管线（"鸡胸"→"鸡胸肉"）的核心依赖，Postgres 内置开箱即用。换库这块要重做。
2. **`jsonb`**——`chat_message.payload` / `pending.candidates` / `parsed_json` 都用，Postgres 的 jsonb 支持最强。
3. **未来 `pgvector`**——v2 上语义召回时加扩展即可，不换库、不引向量库。

对比：SQLite 是单机/客户端库，不适合多用户后端主库（写并发弱、无好用模糊匹配）——但**前端本地缓存层用它**（聊天最近30天，见 §5），那是缓存不是主库；MySQL 中文模糊匹配与 jsonb 不如 Postgres 顺；MongoDB 不匹配本项目强关系、强一致的统计需求。

> 本地 Postgres 用 Docker 起最干净：`./start.sh db` 即可，删容器即清理。`pg_trgm` 由 T02 迁移自动创建。
>
> **托管不锁定**：上线跑在哪只是运维选择——本地、自建、任意托管（含但不限于 Neon）皆可，对代码透明。各家价格随时变，要用时按当时 pricing 选，本项目不依赖任何特定厂商。

## 8. 配置与密钥
`backend/.env`：`DATABASE_URL`、`DEEPSEEK_API_KEY`、`JWT_SECRET`。
**DeepSeek key 与 JWT secret 只在后端**，前端永不持有。
