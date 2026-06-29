# AI 减脂助手

聊天驱动的减脂记录 App。AI 理解，后端按食物营养库算热量，DB 是唯一真相，UI 极简。

## 快速启动（一键）

```bash
# 1) 首次配密钥（数据库默认本地，无需改）
cp backend/.env.example backend/.env      # 然后填 DEEPSEEK_API_KEY 与 JWT_SECRET

# 2) 一条命令拉起全部：本地数据库 + 后端 + 前端
./start.sh
```

需先装 **Docker** 与 **Node 20+**。`./start.sh` 会自动起本地 Postgres 容器、装依赖、迁移、首次灌食物库、起后端，再起前端（Expo）。Ctrl+C 退出会一并关后端；本地数据库容器保留在后台，需停止用 `./start.sh stop`。

> 前端目录 `frontend/` 由任务 T13 创建。在它存在前，`./start.sh` 会只跑后端。

## 文档
- `CLAUDE.md` — 项目宪法（铁律 + 索引 + 运行）
- `docs/` — 全部规范（PRD / ARCHITECTURE / DATA_MODEL / API_SPEC / …）
- `docs/TASKS.md` + `docs/tasks/` — 开发任务，逐个喂 Claude Code

## 技术栈
前端 Expo React Native；后端 Node + Fastify；数据库 PostgreSQL（pg_trgm）；AI 用 DeepSeek V4。
