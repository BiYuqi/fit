# T14 — API 客户端 + 认证态 + 登录页 + 本地缓存

**状态**：✅ 完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：打通登录与 token 持久化，建本地缓存层。
**依赖**：T08 T13　**关注文档**：API_SPEC，ARCHITECTURE §5


## 设计接入（视觉事实源）
用 claude_design MCP 导入设计的 **登录/注册屏** 做像素参照，在 RN 重建，**不要套用 .dc.html**。
- MCP：`https://api.anthropic.com/v1/design/mcp`（auth via `/design-login`）
- 项目：`https://claude.ai/design/p/7937f4c7-b628-4bbd-9801-f3855f803107?file=AI+%E5%87%8F%E8%84%82%E8%AE%B0%E5%BD%95+App.dc.html`

## 做什么
- TanStack Query + 带 JWT 的请求封装；expo-secure-store 存 token；Zustand 认证态。
- 注册/登录页：对照设计稿在 RN 重建（复用 T13 主题，浅深两套），接 /auth/*。
- expo-sqlite 本地缓存层(聊天最近30天)的读写骨架。

## 验收
- 注册并进入 App；重开仍登录；登出清 token。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/API_SPEC.md、docs/ARCHITECTURE.md、docs/DESIGN_SPEC.md §7。用 claude_design MCP 导入设计的登录/注册屏做参照。只做任务 T14：实现 API 客户端 + JWT 持久化(secure-store) + 认证态 + 注册/登录页(对照设计在 RN 重建，不套 .dc.html) + expo-sqlite 缓存骨架。验证登录持久化。
