# T15 — Onboarding 七步 UI

**状态**：✅ 完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：首次必经的身体数据收集流程。
**依赖**：T09 T14　**关注文档**：DESIGN_SPEC §2


## 设计接入（视觉事实源）
用 claude_design MCP 导入设计的 **Onboarding 七步 屏**做像素参照，在 RN 重建，**不要套用 .dc.html**。
- MCP：`https://api.anthropic.com/v1/design/mcp`（auth via `/design-login`）
- 项目：`https://claude.ai/design/p/7937f4c7-b628-4bbd-9801-f3855f803107?file=AI+%E5%87%8F%E8%84%82%E8%AE%B0%E5%BD%95+App.dc.html`

## 做什么
- 七步分步表单(react-hook-form)：性别→年龄→身高+体重→目标体重→活动水平→目标节奏→结果欢迎页。带进度条。
- 完成调 PUT /user/profile；onboarded=false 时强制进入此流程。

## 验收
- 走完七步后置 onboarded 并展示 TDEE/目标，进入 Chat。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/DESIGN_SPEC.md §2、docs/API_SPEC.md。用 claude_design MCP 导入设计的 Onboarding 屏做参照。只做任务 T15：在 Expo RN 重建 Onboarding 七步流程，完成调 PUT /user/profile，未 onboarded 强制进入。视觉匹配设计，浅深两套，RN 重建不套 .dc.html。
