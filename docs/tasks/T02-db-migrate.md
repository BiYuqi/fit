# T02 — 数据库迁移 + trigram 索引

**状态**：✅ 完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：建好全部表与模糊匹配索引。
**依赖**：T01　**关注文档**：DATA_MODEL，backend/prisma/schema.prisma

## 做什么
- 数据库二选一：**前期本地** `./start.sh db` 起 Docker Postgres，`DATABASE_URL=postgresql://postgres:dev@localhost:5432/fit`；**上线**再换任意 Postgres 托管（自建/Railway/Render/Neon… 只改这一行）。参考 `backend/.env.example`。
- `npx prisma migrate dev --name init` 建表（schema 已含全部 8 表，含 chat_message）。
- 新增一条迁移 SQL：`CREATE EXTENSION IF NOT EXISTS pg_trgm;` 与 `FoodStandard.name` 的 GIN trigram 索引（见 schema.prisma 末尾注释）。

## 验收
- 数据库中 8 张表存在；`npx prisma studio` 可开。
- `SELECT name, similarity(name,'牛肉面') s FROM "FoodStandard" WHERE name % '牛肉面' ORDER BY s DESC LIMIT 5;` 不报错。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/DATA_MODEL.md。只做任务 T02：用 backend/prisma/schema.prisma 跑 prisma 迁移建表，并新增迁移启用 pg_trgm 扩展、给 FoodStandard.name 建 GIN trigram 索引。做完验证 similarity 查询不报错。
