# T08 — 注册/登录

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：account+password 的极简认证。
**依赖**：T02　**关注文档**：API_SPEC 认证，CLAUDE 铁律 5

## 做什么
- Prisma 插件注入 Fastify。
- `POST /api/auth/register`(account 唯一校验 409 / argon2 哈希 / 返回 JWT)、`POST /api/auth/login`、@fastify/jwt 鉴权中间件。
- 无邮箱验证/找回/第三方。

## 验收
- register→login→带 token 访问受保护路由通；无 token 401；重复 account 返回 409。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/API_SPEC.md。只做任务 T08：实现注册/登录(account 唯一, argon2, JWT)与鉴权中间件。验证 register→login→受保护路由，及无 token 401、重复 account 409。
