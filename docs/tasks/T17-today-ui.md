# T17 — Today 页

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：今日摄入/消耗/缺口/营养素/目标完成度。
**依赖**：T12　**关注文档**：DESIGN_SPEC §4


## 设计接入（视觉事实源）
用 claude_design MCP 导入设计的 **Today 屏**做像素参照，在 RN 重建，**不要套用 .dc.html**。
- MCP：`https://api.anthropic.com/v1/design/mcp`（auth via `/design-login`）
- 项目：`https://claude.ai/design/p/7937f4c7-b628-4bbd-9801-f3855f803107?file=AI+%E5%87%8F%E8%84%82%E8%AE%B0%E5%BD%95+App.dc.html`

## 做什么
- 接 /daily/today；环形完成度 + 缺口(视觉重点) + 摄入/目标 + 三大营养素进度 + 一行均衡提示。

## 验收
- 数值与 Chat 记录一致；无数据时空状态。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/DESIGN_SPEC.md §4。用 claude_design MCP 导入设计的 Today 屏做参照。只做任务 T17：在 RN 实现 Today 页(接 /daily/today，缺口为视觉重点)，视觉匹配设计，RN 重建不套 .dc.html。
