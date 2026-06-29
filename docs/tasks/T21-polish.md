# T21 — 收尾打磨

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：状态、边界、保留任务、出包。
**依赖**：贯穿，最后做　**关注文档**：TEST_PLAN，ARCHITECTURE §6/§7，DESIGN_SPEC §7

## 做什么
- 各数据视图补 loading/空/错误三态；离线读缓存提示；记录失败重试。
- 边界：解析失败、断网、DeepSeek 429 的兜底与提示。
- 保留策略后台任务：每日清理 365 天前 chat_message（**绝不动 food_record**）。
- 套用 Claude Design 视觉细节(浅/深)。
- EAS Build/Update 配置，出测试包。

## 验收
- TEST_PLAN 全表过；构造 366 天前聊天被清而同日 food_record 仍在。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/TEST_PLAN.md、docs/ARCHITECTURE.md。只做任务 T21：补全状态/边界、实现聊天保留清理任务(只清 chat_message)、套用视觉、配置 EAS。按 TEST_PLAN 逐条过。
