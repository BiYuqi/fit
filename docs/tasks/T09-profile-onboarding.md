# T09 — 用户档案 + Onboarding

**状态**：⬜ 待办  <!-- ⬜待办 / 🔄进行中 / ✅完成；任务验收通过后改这里 + 同步 docs/TASKS.md -->

**目标**：保存身体数据并算出 TDEE/目标。
**依赖**：T06 T08　**关注文档**：API_SPEC 用户，CALORIE_ENGINE

## 做什么
- `GET /api/user/profile`、`PUT /api/user/profile`：PUT 时用 calc 算 bmr/tdee/target_calories/target_protein，置 onboarded=true。
- GET 返回档案 + 计算结果。

## 验收
- PUT 一份档案后返回正确 tdee 与 target_calories；onboarded 变 true。

## 给 Claude Code 的提示词
> 参考 CLAUDE.md、docs/API_SPEC.md、docs/CALORIE_ENGINE.md。只做任务 T09：实现 GET/PUT /user/profile，PUT 时计算并存 bmr/tdee/targets 并置 onboarded。验证返回值正确。
