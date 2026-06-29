# T13 — Expo 骨架 + 导航 + 主题（设计接入总入口）

**状态**：✅ 完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：导入设计、抽取 token 建主题、四个 Tab 空页面。
**依赖**：T01（可与后端并行）　**关注文档**：DESIGN_SPEC §0/§1，ARCHITECTURE 前端栈

## 设计接入（视觉事实源）
用 claude_design MCP 导入设计做参照，在 RN 重建，**不要把 .dc.html 当成品直接实现/套用**。
- MCP：`https://api.anthropic.com/v1/design/mcp`（auth via `/design-login`）
- 项目：`https://claude.ai/design/p/7937f4c7-b628-4bbd-9801-f3855f803107?file=AI+%E5%87%8F%E8%84%82%E8%AE%B0%E5%BD%95+App.dc.html`
- 文件：`AI 减脂记录 App.dc.html`

## 做什么
- 用 MCP 导入设计，**抽取 design token**：配色、圆角、模糊强度、字号层级、浅/深两套。
- frontend：Expo Router 底部 Tab(Chat/Today/History/Settings)，Chat 默认。
- 装 NativeWind v4 + expo-blur + reanimated；把 token 建成主题（毛玻璃卡片、圆角、配色）。

## 验收
- 四个空 Tab 能渲染，浅/深切换正常，毛玻璃卡片样式取自设计 token。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/DESIGN_SPEC.md(§0/§1)。用 claude_design MCP(`https://api.anthropic.com/v1/design/mcp`, auth via /design-login)导入项目 `https://claude.ai/design/p/7937f4c7-b628-4bbd-9801-f3855f803107?file=AI+%E5%87%8F%E8%84%82%E8%AE%B0%E5%BD%95+App.dc.html`。只做任务 T13：从设计抽取 token(配色/圆角/模糊/字号/浅深)，在 Expo(NativeWind+expo-blur)建主题与四 Tab 骨架。**用 RN 组件重建，不要直接实现或套用 .dc.html。** 四个空页能渲染即可。
