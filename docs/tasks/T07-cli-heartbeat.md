# T07 — 命令行心跳脚本（里程碑 M1）

**状态**：✅ 完成  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：串起解析→匹配→计算，证明核心可行。
**依赖**：T04 T05 T06　**关注文档**：TEST_PLAN 里程碑

## 做什么
- `backend/scripts/heartbeat.ts`：读 stdin 文本 → parser → matcher → calc → 打印每项(食物名/克数/各营养/kcal)与合计。

## 验收
- 跑 "中午一碗牛肉面加个蛋"，打印两项食物、克数、合计 kcal，数值合理。**M1 达成。**

## 给 Claude Code 的提示词
> 参考 CLAUDE.md。只做任务 T07：写命令行脚本串起 parser+matcher+calc，输入一句话打印食物/克数/合计热量。用"中午一碗牛肉面加个蛋"验证。这是里程碑 M1。
