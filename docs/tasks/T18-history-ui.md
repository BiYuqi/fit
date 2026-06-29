# T18 — History 页

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：日/周/月统计 + 趋势 + 分组列表。
**依赖**：T12　**关注文档**：DESIGN_SPEC §5


## 设计接入（视觉事实源）
用 claude_design MCP 导入设计的 **History 屏**做像素参照，在 RN 重建，**不要套用 .dc.html**。
- MCP：`https://api.anthropic.com/v1/design/mcp`（auth via `/design-login`）
- 项目：`https://claude.ai/design/p/7937f4c7-b628-4bbd-9801-f3855f803107?file=AI+%E5%87%8F%E8%84%82%E8%AE%B0%E5%BD%95+App.dc.html`

## 做什么
- 接 /daily/range；日/周/月切换；趋势折线(缺口/摄入) + 达标徽标；按日期+餐次分组的记录列表。

## 验收
- 切换粒度数据正确；列表分组正确。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/DESIGN_SPEC.md §5。用 claude_design MCP 导入设计的 History 屏做参照。只做任务 T18：在 RN 实现 History 页(日/周/月切换+趋势图+分组列表，接 /daily/range)，视觉匹配设计，RN 重建不套 .dc.html。
