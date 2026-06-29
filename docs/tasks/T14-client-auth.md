# T14 — API 客户端 + 认证态 + 登录页 + 本地缓存

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：打通登录与 token 持久化，建本地缓存层。
**依赖**：T08 T13　**关注文档**：API_SPEC，ARCHITECTURE §5

## 做什么
- TanStack Query + 带 JWT 的请求封装；expo-secure-store 存 token；Zustand 认证态。
- 注册/登录页，接 /auth/*。
- expo-sqlite 本地缓存层(聊天最近30天)的读写骨架。

## 验收
- 注册并进入 App；重开仍登录；登出清 token。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/API_SPEC.md、docs/ARCHITECTURE.md。只做任务 T14：实现 API 客户端 + JWT 持久化(secure-store) + 认证态 + 注册/登录页 + expo-sqlite 缓存骨架。验证登录持久化。
