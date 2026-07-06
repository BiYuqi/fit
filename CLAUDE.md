# CLAUDE.md — AI 减脂助手

一个用聊天驱动的结构化减脂记录 App：用户自然语言说吃了/动了什么，AI 理解，后端按食物营养库算热量与缺口。

> 本文件是项目宪法：只放**铁律**、**文档索引**、**运行方式**。所有细节在 `docs/` 里，**不在这里重复**。

## 铁律（不可违反）

1. **AI 绝不算账。** 热量/营养只能由后端用 `food_standard` 的每100g数值 × 克数算出。AI 只负责理解、估份量、估兜底营养。
2. **数据库是唯一事实源。** `food_record` / `daily_summary` 是真相。Today/History 只读它们。
3. **聊天记录是展示层，不是事实源。** `chat_message` 只用于回放显示，**Today/History 绝不读它**；删聊天不影响热量统计。
4. **食物匹配不用 embedding。** 用 DeepSeek 归一 + pg_trgm 模糊匹配（见 AI_PARSING_SPEC）。语义记忆检索不属于此条管辖（见 MEMORY_SPEC）。
5. **认证极简**：账号 + 密码，account 唯一即可。无邮箱验证、无找回密码、无第三方登录。
6. **不做**「最近吃过 / 收藏 / 一键重记」。
7. **DeepSeek key 只在后端**，绝不进前端。
8. **仓库不使用 npm workspaces**：`backend/` 与 `frontend/` 是两个独立 npm 项目，靠 `docs/API_SPEC.md` 对齐契约。
9. 包管理一律 **npm**。
10. **一次只做一个任务**：按 `docs/TASKS.md` 的顺序，逐个执行 `docs/tasks/` 下的任务文件，自测验收通过再进下一个，不要顺手多做。
11. **完成即更新状态**：每个任务验收通过后，把状态改为 ✅ 于两处——`docs/tasks/Txx.md` 顶部状态行 + `docs/TASKS.md` 清单表该行（顶部进度计数与里程碑也一并更新）。开始做时可先标 🔄。

## 文档索引（每份只管一件事）

| 文档 | 管什么 |
|------|--------|
| `docs/PRD.md` | 产品要什么、范围、非目标 |
| `docs/ARCHITECTURE.md` | 技术栈、仓库结构、数据流、本地缓存/同步、聊天保留策略、部署 |
| `docs/DB_HOSTING.md` | 本地库托管：Docker vs 原生 Postgres 决策 + 迁移方案（暂缓） |
| `docs/DATA_MODEL.md` | 所有表与字段语义（字段的**唯一定义处**） |
| `docs/API_SPEC.md` | 接口契约（前后端**唯一对齐源**） |
| `docs/FOOD_DB_SPEC.md` | 食物库领域规范：数据源、三层结构、版权 |
| `docs/AI_PARSING_SPEC.md` | DeepSeek 解析、意图路由、置信度、匹配、上下文卡 |
| `docs/CALORIE_ENGINE.md` | BMR/TDEE/缺口/目标 计算口径（公式的**唯一定义处**） |
| `docs/LEARNING_SPEC.md` | 自学习机制：学习信号、偏差模型、更新/应用算法（学习公式的**唯一定义处**） |
| `docs/MEMORY_SPEC.md` | 语义记忆系统（设计稿）：从对话提取用户偏好/忌口/习惯，pgvector 检索注入（尚未进入任务拆分） |
| `docs/DESIGN_SPEC.md` | UI 行为规格（视觉稿已由 Claude Design 产出） |
| `docs/TEST_PLAN.md` | 后端验证计划（curl 流程、一致性） |
| `docs/TESTING.md` | 前端组件测试规范：怎么写、怎么跑、已知坑 |
| `docs/TASKS.md` | 任务总览：依赖图 + 执行顺序 + 状态 + 进度 |
| `docs/tasks/*.md` | 一任务一文件：做什么 / 验收 / 可粘贴的提示词 |

> 引用规则：同一信息只在一处定义。字段去 DATA_MODEL，公式去 CALORIE_ENGINE，接口去 API_SPEC，别处只引用不重抄。

## Compact Instructions

When compressing, preserve in priority order:

1. Architecture decisions (NEVER summarize)
2. Modified files and their key changes
3. Current verification status (pass/fail)
4. Open TODOs and rollback notes
5. Tool outputs (can delete, keep pass/fail only)

## 运行

```bash
# 首次：cp backend/.env.example backend/.env 并补 DEEPSEEK_API_KEY / JWT_SECRET
./start.sh          # 真·一键：起本地数据库 + 装依赖 + 迁移 + 灌库 + 后端 + 前端
./start.sh seed     # 仅重灌食物库
./start.sh stop     # 停掉本地数据库容器
```

需 Docker 与 Node 20+。数据库默认本地（容器），上线换任意 Postgres 托管只改 `backend/.env` 的 `DATABASE_URL`。选型理由见 ARCHITECTURE §7.1。

> **给 AI 的备注**：`:9300` 是**常驻 prod 后端**（launchd `com.fit` 自启 + KeepAlive，服务真机/公网）——**别去停它、重启它、rebuild dist 或占它的端口**，那是用户自己管的。要跑 eval 或验证改动，**自己另起服务**打自己的：起个干净端口 `PORT=9309 npm run dev`（tsx watch 热重载）配 `EVAL_API_BASE=http://localhost:9309 npm run eval`，或 `./start.sh ios` 用 `:9301`。端口拓扑与部署见 `docs/DEPLOY.md`。
