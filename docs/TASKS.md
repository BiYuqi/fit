# TASKS — 任务总览

> 本文件只放**依赖图**与**执行顺序**。每个任务的"做什么/验收/提示词"在 `docs/tasks/Txx-*.md`，**不在此重复**。
> 用法：一次只做一个任务，按下方顺序，自测验收通过再下一个。
> 状态：⬜待办 / 🔄进行中 / ✅完成。**任务验收通过后更新两处**：本表该行 + `tasks/Txx.md` 顶部状态行。

**进度：10 / 21**　里程碑：✅ M1 命令行心跳(T07)　⬜ M2 后端全通(T12)　⬜ 前端可用(T19)　⬜ 可出包(T21)

## 分轨
- **基建 S**：T01
- **数据 D**：T02 T03
- **后端核心 B**：T04–T12
- **前端 F**：T13–T20
- **打磨 P**：T21

## 依赖图
```
T01 ─┬─ T02 ── T03 ───────────────┐
     │                            │
     └─ T04 ─┬ T05(需T03) ┐       │
             └ T06        ├ T07(M1)│
                          ┘        │
T07 ─ T08 ─ T09 ─ T10 ─ T11 ─ T12(M2)
                                   │
T13 ─ T14 ─┬ T15(需T09)            │
           ├ T16(需T11/T12)  ← 核心 │
           ├ T17(需T12)            │
           ├ T18(需T12)            │
           ├ T19(需T09)            │
           └ T20                   │
T21（贯穿，最后收尾）
```
说明：T13 前端骨架不依赖接口，可在后端推进时并行起；但真实联调要等对应后端任务（T15↔T09，T16↔T11/T12，T17/T18↔T12，T19↔T09）。

## 执行顺序（交给 Claude Code 的次序）
```
T01 → T02 → T03 → T04 → T05 → T06 → T07(✅M1)
    → T08 → T09 → T10 → T11 → T12(✅M2)
    → T13 → T14 → T15 → T16 → T17 → T18 → T19 → T20
    → T21
```

## 任务清单
| 状态 | ID | 文件 | 一句话 |
|----|----|------|--------|
| ✅ | T01 | tasks/T01-scaffold.md | 仓库骨架：backend/frontend 两个独立项目 + 后端 health |
| ✅ | T02 | tasks/T02-db-migrate.md | Prisma 迁移 + pg_trgm 索引 |
| ✅ | T03 | tasks/T03-seed-food-db.md | 食物库导入与清洗（含能量自检） |
| ✅ | T04 | tasks/T04-deepseek-parse.md | DeepSeek 客户端 + 解析协议 + 意图路由 |
| ✅ | T05 | tasks/T05-food-matcher.md | 食物匹配管线（pg_trgm + 兜底） |
| ✅ | T06 | tasks/T06-calorie-engine.md | 计算引擎（BMR/TDEE/热量） |
| ✅ | T07 | tasks/T07-cli-heartbeat.md | 命令行心跳：一句话→热量（M1） |
| ✅ | T08 | tasks/T08-auth.md | 注册/登录（account+password） |
| ✅ | T09 | tasks/T09-profile-onboarding.md | 用户档案 + Onboarding 算 TDEE |
| ✅ | T10 | tasks/T10-daily-summary.md | 每日汇总 + 上下文卡 |
| ⬜ | T11 | tasks/T11-chat-endpoint.md | /chat/message + /pending/resolve + 聊天落库 |
| ⬜ | T12 | tasks/T12-query-endpoints.md | 查询接口 + 聊天记录接口（M2） |
| ⬜ | T13 | tasks/T13-expo-scaffold.md | Expo 骨架 + 导航 + Liquid Glass 主题 |
| ⬜ | T14 | tasks/T14-client-auth.md | API 客户端 + 认证态 + 登录页 + 本地缓存 |
| ⬜ | T15 | tasks/T15-onboarding-ui.md | Onboarding 七步 UI |
| ⬜ | T16 | tasks/T16-chat-ui.md | Chat 页（核心，各类卡片+持久化） |
| ⬜ | T17 | tasks/T17-today-ui.md | Today 页 |
| ⬜ | T18 | tasks/T18-history-ui.md | History 页 |
| ⬜ | T19 | tasks/T19-settings-ui.md | Settings 页（含清除缓存） |
| ⬜ | T20 | tasks/T20-voice-input.md | 语音输入 |
| ⬜ | T21 | tasks/T21-polish.md | 状态/边界/保留任务/EAS 收尾 |
