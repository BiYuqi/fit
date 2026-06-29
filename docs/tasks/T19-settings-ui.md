# T19 — Settings 页

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：编辑档案实时重算 TDEE + 清除本地缓存。
**依赖**：T09 T14　**关注文档**：DESIGN_SPEC §6，ARCHITECTURE §5


## 设计接入（视觉事实源）
用 claude_design MCP 导入设计的 **Settings 屏**做像素参照，在 RN 重建，**不要套用 .dc.html**。
- MCP：`https://api.anthropic.com/v1/design/mcp`（auth via `/design-login`）
- 项目：`https://claude.ai/design/p/7937f4c7-b628-4bbd-9801-f3855f803107?file=AI+%E5%87%8F%E8%84%82%E8%AE%B0%E5%BD%95+App.dc.html`

## 做什么
- 顶部实时显示 目标摄入/TDEE/缺口；身体数据组 + 目标组(每日缺口滑杆)；改动即 PUT /user/profile 并刷新。
- "清除本地缓存"按钮：只清 expo-sqlite 本地镜像，服务端不动。

## 验收
- 改活动水平后顶部 TDEE 变化；清缓存后重进能从服务端拉回聊天。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/DESIGN_SPEC.md §6。用 claude_design MCP 导入设计的 Settings 屏做参照。只做任务 T19：在 RN 实现 Settings(编辑档案实时重算+清除本地缓存只清本地)，视觉匹配设计，RN 重建不套 .dc.html。
