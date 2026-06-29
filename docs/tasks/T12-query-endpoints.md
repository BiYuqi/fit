# T12 — 查询接口 + 聊天记录接口（里程碑 M2）

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：补齐 Today/History 与聊天线程读取接口。
**依赖**：T10 T11　**关注文档**：API_SPEC 查询/聊天记录

## 做什么
- `GET /api/daily/today`（summary+records+exercises）。
- `GET /api/daily/range`（day/week/month 聚合）。
- `GET /api/chat/messages?date=`、`GET /api/chat/dates`（聊天线程，读 chat_message）。

## 验收
- curl 跑完 注册→onboarding→记录→查询→今日→历史 全流程。**M2 达成。**
- 改/删一条 food_record 后 daily 接口同步变化。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/API_SPEC.md。只做任务 T12：实现 daily/today、daily/range、chat/messages、chat/dates。用 curl 跑通端到端全流程(M2)，并验证改记录后 today 同步。
