# T01 — 仓库骨架

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：建好 backend/ 与 frontend/ 两个独立 npm 项目，后端能起。
**依赖**：无　**关注文档**：ARCHITECTURE §3

## 做什么
- 根目录已有 CLAUDE.md / start.sh / docs/。建 `backend/`、`frontend/` 两个独立 npm 项目（**不要 workspaces**）。
- backend：TypeScript + Fastify，`GET /api/health` 返回 `{ok:true}`；`npm run dev` 用 tsx 热跑；准备 `.env.example`（DATABASE_URL/DEEPSEEK_API_KEY/JWT_SECRET）。
- 目录：`backend/src/{routes,services,ai,plugins}`、`backend/prisma/`（schema 已给）、`backend/scripts/seed/`（脚本已给）。
- frontend 暂只 `npm create expo-app@latest frontend`，留到 T13 再配。

## 验收
- `cd backend && npm run dev` 后 `curl localhost:PORT/api/health` 返回 200。
- backend 与 frontend 各自有独立 package.json，根目录无 workspaces 配置。

## 给 Claude Code 的提示词
> 参考仓库 CLAUDE.md 与 docs/ARCHITECTURE.md。只做任务 T01：建 backend/（Fastify+TS，含 /api/health 与 .env.example）和 frontend/（create-expo-app），两者为独立 npm 项目、不用 workspaces。做完确认 health 接口可访问，不要做别的任务。
